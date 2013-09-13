"use strict";

var fs                          = require('fs'),
    path                        = require('path'),
    rng                         = require('crypto').rng,
    _                           = require('underscore'),
    q                           = require('kew'),
    through                     = require('through'),
    nodeResolve                 = require('resolve'),
    browserResolve              = require('browser-resolve'),
    aggregate                   = require('stream-aggregate-promise'),
    asStream                    = require('as-stream'),
    transformResolve            = resolveWith.bind(null, nodeResolve),

    all                         = q.all,
    isString                    = _.isString,
    extend                      = _.extend,

    extractDependencies         = require('./transforms/deps'),
    jsonToCommonJS              = require('./transforms/json')

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
    if (err)
      p.reject(err)
    else
      p.resolve({id: id, filename: filename, package: pkg})
  })
  return p
}

/**
 * Run streaming transform over module
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
function runTransform(transform, mod, opts) {
  return q.resolve(transform(mod, opts)).then(function(transformed) {
    if (!transformed) return mod
    if (transformed.source) mod.source = transformed.source
    if (transformed.deps) mod.deps = extend(mod.deps, transformed.deps)
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
  if (!isString(transform)) return q.resolve(transform)

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
  var result = {id: mod.filename, source: mod.source, deps: {}}
  if (Buffer.isBuffer(result.source))
    result.source = result.source.toString()
  if (mod.entry)
    result.entry = true
  for (var k in mod.deps)
    result.deps[k] = mod.deps[k].filename
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

  if (opts.extensions) opts.extensions.unshift('.js')

  var moduleProto = {
    resolve: function(id, parent) {
      if (opts.filter && !opts.filter(id))
        return q.resolve({id: id, filename: false})
      else
        return resolver(id, parent || this)
    },
    resolveMany: function(ids, parent) {
      return all(ids.map(function(id) {return this.resolve(id, parent)}, this))
        .then(function(resolved) {
          var result = {}
          resolved.forEach(function(r) { result[r.id] = r })
          return result
        })
    }
  }

  var output = through(),
      basedir = opts.basedir || process.cwd(),
      resolve = resolveWith.bind(null, opts.resolve || browserResolve),
      resolveCache = {},
      seen = {},
      entries = [].concat(mains).filter(Boolean).map(makeMainModule)

  all(entries.map(function(mod) {return walk(mod, {filename: '/', id: '/'})}))
    .fail(output.emit.bind(output, 'error'))
    .fin(output.queue.bind(output, null))

  output.asPromise = function() { return aggregate(this) }

  return output

  function emit(mod) {
    output.queue(moduleToResult(mod))
    return mod
  }

  function walk(mod, parent) {
    if (isString(mod)) mod = resolveCache[mod]
    if (seen[mod.filename]) return
    seen[mod.filename] = true

    var cached = checkExternalCache(mod, parent)
    if (cached) {
      emit(cached)
      return walkDeps(cached, parent)
    }

    return applyTransforms(mod).then(emit).then(walkDeps)
  }

  function walkDeps(mod) {
    return all(Object.keys(mod.deps)
      .filter(function(id) { return mod.deps[id] })
      .map(function(id) { return walk(mod.deps[id], mod) }))
  }

  function makeModule(mod) {
    var result = Object.create(moduleProto)
    extend(result, mod)
    result.deps = mod.deps || {}
    return result
  }

  function makeMainModule(m) {
    var filename,
        mod = makeModule({entry: true})

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

  // Wrapper around browser-resolve which passes configurations
  function resolver(id, parent) {
    parent.packageFilter = opts.packageFilter
    parent.extensions = opts.extensions
    parent.modules = opts.modules
    parent.paths = []
    return resolve(id, parent).then(makeModule)
      .then(function(mod) { return resolveCache[mod.id] = mod })
      .fail(function(err) {
        err.message += [', module required from', parent.filename].join(' ')
        throw err
      })
  }

  // Allows to store module and package definitions in a opts.cache and
  // opts.packageCache respectively, this is how module-deps does it
  function checkExternalCache(mod, parent) {
    if (!(opts.cache && opts.cache[parent.filename])) return
    var curFilename = opts.cache[parent.filename].deps[mod.id]
    var result = opts.cache[curFilename]
    if (!result) return
    return {id: mod.id, filename: curFilename,
      deps: result.deps, source: result.source, entry: result.entry,
      package: opts.packageCache && opts.packageCache[result.id]}
  }

  function isTopLevel(mod) {
    return entries.some(function (entry) {
      return path.relative(path.dirname(entry.filename), mod.filename)
        .split('/').indexOf('node_modules') < 0
    })
  }

  // Apply global and per-package transforms on a module
  // It automatically inserts extractDependencies transform
  function applyTransforms(mod) {
    var txs = [],
        p = (mod.sourcePromise || aggregate(fs.createReadStream(mod.filename)))
            .then(function(source) {
              mod.source = source
              return mod
            })

    if (isTopLevel(mod))
      txs = txs.concat(opts.transform)

    if (mod.package && opts.transformKey)
      txs = txs.concat(getTransform(mod.package, opts.transformKey))

    txs = txs.filter(Boolean).map(loadTransform.bind(null, mod))
    txs.push(extractDependencies)
    txs.push(jsonToCommonJS)

    return all(txs).then(function(txs) {
      txs.forEach(function(t) {
        p = p.then(function(p) {
          if (t.length === 1)
            return runStreamTransform(t, p)
          else
            return runTransform(t, p, opts)
        })
      })
      return p
    })
  }
}
