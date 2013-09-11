/* jshint asi: true, expr: true, globalstrict: true */
/* global require, Buffer, process, module */
"use strict";

var fs                = require('fs'),
    path              = require('path'),
    rng               = require('crypto').rng,
    _                 = require('underscore'),
    q                 = require('kew'),
    through           = require('through'),
    nodeResolve       = require('resolve'),
    browserResolve    = require('browser-resolve'),
    detective         = require('detective'),
    aggregate         = require('stream-aggregate-promise'),
    asStream          = require('as-stream'),
    transformResolve  = resolveWith.bind(null, nodeResolve)

/**
 * Resolve module by id
 *
 * @param {Function<String, Object, Callback>} resolve
 * @param {String} id
 * @param {Object} parent
 * @return {Promise<Object>} an object with id, filename and package keys
 */
function resolveWith(resolve, id, parent) {
  var p = q.defer()
  resolve(id, parent, function(err, filename, pkg) {
    err ? p.reject(err) : p.resolve({id: id, filename: filename, package: pkg})
  })
  return p
}

/**
 * Run stream transform over module
 *
 * Such transforms are compatible with transforms for browserify
 *
 * @param {Function<String>} transform a transform factory
 * @param {Object} mod a module to run transform over
 * @return {Promise<Object>} a transformed module
 */
function runStreamTransform(transform, mod) {
  return aggregate(asStream(mod.source).pipe(transform(mod.filename)))
    .then(function(source) {
      mod.source = source
      return mod
    })
}

/**
 * Run transform over module
 *
 * @param {Function<String>} transform a transform factory
 * @param {Object} mod a module to run transform over
 * @return {Promise<Object>} a transformed module
 */
function runTransform(transform, mod) {
  return q.resolve(transform(mod.filename, mod)).then(function(transformed) {
    if (transformed.source) mod.source = transformed.source
    if (transformed.deps) mod.deps = _.extend(mod.deps, transformed.deps)
    return mod
  })
}

/**
 * Load transform from a package
 *
 * @param {Object} pkg a package to load transform from
 * @param {Array<String>} key an array of strings represents a path in a package
 * @return {Array<String>} a list of transform ids
 */
function getTransform(pkg, key) {
  var n = pkg
  key.forEach(function (k) { if (n && typeof n === 'object') n = n[k] })
  return [].concat(n).filter(Boolean)
}

/**
 * Load transform relative to specified module
 *
 * It tries to resolve transform relative to module's filename first and then
 * fallback's to process.cwd()
 *
 * @param {Object} mod a module
 * @param {String} transform a transform module id
 * @return {Promise<Function>} a loaded transform function
 */
function loadTransform(mod, transform) {
  if (!_.isString(transform)) return q.resolve(transform)

  return transformResolve(transform, {basedir: path.dirname(mod.filename)})
    .fail(function() {
      return transformResolve(transform, {basedir: process.cwd()})
    })
    .then(function(res) {
      if (!res)
        throw new Error([
          'cannot find transform module ', transform,
          ' while transforming ', mod.filename
        ].join(''))
      return require(res.filename)
    })
}

/**
 * Resolve a graph of dependencies for a specified set of modules
 *
 * This is compatible with module-deps implementation with a few addition
 * features
 *
 * @param {Array<String|Stream>} mains a list of module ids, paths or streams
 * @param {Object} opts an options object compatible with module-deps
 * @return {Stream<Object>} a stream of resolved modules with dependencies
 */
module.exports = function(mains, opts) {
  opts = opts || {}

  var output = through(),
      basedir = opts.basedir || process.cwd(),
      resolve = resolveWith.bind(null, opts.resolve || browserResolve),
      cache = {},
      seen = {},
      entries = [].concat(mains).filter(Boolean).map(makeMainModule)

  q.all(entries.map(function(mod) {return walk(mod, {filename: '/', id: '/'})}))
    .fail(output.emit.bind(output, 'error'))
    .fin(output.queue.bind(output, null))

  return output

  function makeMainModule(m) {
    var filename,
        mod = {entry: true, deps: {}}
    if (typeof m.pipe === 'function') {
      filename = path.join(basedir, rng(8).toString('hex') + '.js')
      mod.id = filename
      mod.filename = filename
      mod.sourcePromise = aggregate(m)
    } else {
      filename = path.resolve(m)
      mod.id = filename
      mod.filename = filename
    }
    return mod
  }

  function moduleToResult(mod) {
    var result = {id: mod.filename, source: mod.source, deps: mod.deps}
    if (mod.entry) result.entry = true
    return result
  }

  function resolver(id, parent) {
    parent.packageFilter = opts.packageFilter
    parent.extensions = opts.extensions
    parent.modules = opts.modules
    parent.paths = []
    var bucket = (cache[parent.filename] = cache[parent.filename] || {})
    return bucket[id] ? bucket[id] : bucket[id] = resolve(id, parent)
  }

  function checkCache(mod, parent) {
    if (!(opts.cache && opts.cache[parent.filename])) return
    var curFilename = opts.cache[parent.filename].deps[mod.id]
    var result = opts.cache[curFilename]
    if (!result) return
    return {id: mod.id, filename: curFilename,
      deps: result.deps, source: result.source, entry: result.entry,
      package: opts.packageCache && opts.packageCache[result.id]}
  }

  function walk(mod, parent) {
    var cached = checkCache(mod, parent)
    if (cached) {
      output.emit(moduleToResult(cached))
      return walkDeps(cached, parent)
    }
    return ((!mod.filename && mod.id) ?
      resolver(mod.id, parent).then(_.extend.bind(null, mod)) :
      q.resolve(mod))
    .then(function(mod) {
      if (seen[mod.filename]) return
      seen[mod.filename] = true

      if (!mod.sourcePromise)
        mod.sourcePromise = aggregate(fs.createReadStream(mod.filename))

      return applyTransforms(mod).then(function(mod) {
        if (Buffer.isBuffer(mod.source)) mod.source = mod.source.toString()
        output.queue(moduleToResult(mod))
        return walkDeps(mod)
      })
    })
  }

  function walkDeps(mod) {
    return q.all(Object.keys(mod.deps)
      .filter(function(depId) { return mod.deps[depId] })
      .map(function(depId) { return walk({id: depId, deps: {}}, mod) }))
  }

  function extractDeps(filename, mod) {
    if (opts.noParse && opts.noParse.indexOf(filename) > -1) return {}
    var deps = detective(mod.source)
    return q.all(deps.map(function(id) {
      return ((opts.filter && !opts.filter(id)) ?
        q.resolve({id: id, filename: false}) : resolver(id, mod))
    })).then(function(deps) {
      deps.forEach(function(dep) { mod.deps[dep.id] = dep.filename })
      return mod
    })
  }

  function applyTransforms(mod) {
    var isTopLevel = entries.some(function (entry) {
          return path.relative(path.dirname(entry.filename), mod.filename)
            .split('/').indexOf('node_modules') < 0
        }),
        txs = [extractDeps],
        p = mod.sourcePromise.then(function(source) {
          mod.source = source
          return mod
        })

    if (isTopLevel)
      txs = txs.concat(opts.transform)

    if (mod.package && opts.transformKey)
      txs = txs.concat(getTransform(mod.package, opts.transformKey))

    return q.all(txs.filter(Boolean).map(loadTransform.bind(null, mod)))
      .then(function(txs) {
        txs.forEach(function(t) {
          p = p.then(function(p) {
            return (t.length === 1 ? runStreamTransform : runTransform)(t, p)
          })
        })
        return p
      })
  }
}
