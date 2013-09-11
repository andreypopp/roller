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
    transformResolve  = resolveWith.bind(null, nodeResolve),
    all               = q.all

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
    if (!transformed) return mod
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
  key.forEach(function (k) { if (pkg && typeof pkg === 'object') pkg = pkg[k] })
  return [].concat(pkg).filter(Boolean)
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
    .fail(function(err) {
      err.message += ' which is required as a transform'
      throw err
    })
}

/**
 * Convert module object into a format suitable for browser-pack
 *
 * @param {Object} mod an object representing some module
 * @return {Object} an object suitable for browser-pack consumption
 */
function moduleToResult(mod) {
  if (!mod.filename) return mod
  var result = {id: mod.filename, source: mod.source, deps: mod.deps}
  if (Buffer.isBuffer(result.source))
    result.source = result.source.toString()
  if (mod.entry)
    result.entry = true
  return result
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

  all(entries.map(function(mod) {return walk(mod, {filename: '/', id: '/'})}))
    .fail(output.emit.bind(output, 'error'))
    .fin(output.queue.bind(output, null))

  return output

  function emit(mod) {
    output.queue(moduleToResult(mod))
    return mod
  }

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

  function resolver(id, parent) {
    parent.packageFilter = opts.packageFilter
    parent.extensions = opts.extensions
    parent.modules = opts.modules
    parent.paths = []
    var bucket = (cache[parent.filename] = cache[parent.filename] || {})
    return bucket[id] ? bucket[id] : bucket[id] = resolve(id, parent)
      .fail(function(err) {
        err.message += [', module required from', parent.filename].join(' ')
        throw err
      })
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
      if (seen[cached.filename]) return
      emit(cached)
      return walkDeps(cached, parent)
    }

    var resolved = ((!mod.filename && mod.id) ?
      resolver(mod.id, parent).then(_.extend.bind(null, mod)) :
      q.resolve(mod))

    return resolved.then(function(mod) {
      if (seen[mod.filename]) return
      seen[mod.filename] = true
      return applyTransforms(mod).then(emit).then(walkDeps)
    })
  }

  function walkDeps(mod) {
    return all(Object.keys(mod.deps)
      .filter(function(depId) { return mod.deps[depId] })
      .map(function(depId) { return walk({id: depId, deps: {}}, mod) }))
  }

  function extractDeps(filename, mod) {
    if (opts.noParse && opts.noParse.indexOf(filename) > -1) return

    var deps = detective(mod.source).map(function(id) {
      var resolved
      if (opts.filter && !opts.filter(id))
        resolved = q.resolve({id: id, filename: false})
      else
        resolved = resolver(id, mod)

      return resolved.then(function(dep) { mod.deps[dep.id] = dep.filename })
    })

    return all(deps).then(function() { return mod })
  }

  function applyTransforms(mod) {
    var isTopLevel = entries.some(function (entry) {
          return path.relative(path.dirname(entry.filename), mod.filename)
            .split('/').indexOf('node_modules') < 0
        }),
        txs = [extractDeps],
        p = (mod.sourcePromise || aggregate(fs.createReadStream(mod.filename)))
            .then(function(source) {
              mod.source = source
              return mod
            })

    if (isTopLevel)
      txs = txs.concat(opts.transform)

    if (mod.package && opts.transformKey)
      txs = txs.concat(getTransform(mod.package, opts.transformKey))

    txs = txs.filter(Boolean).map(loadTransform.bind(null, mod))

    return all(txs).then(function(txs) {
      txs.forEach(function(t) {
        p = p.then(function(p) {
          return (t.length === 1 ? runStreamTransform : runTransform)(t, p)
        })
      })
      return p
    })
  }
}
