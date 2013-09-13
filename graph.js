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
    asPromise                   = q.resolve,
    clone                       = _.clone,
    isString                    = _.isString,
    isObject                    = _.isObject,
    extend                      = _.extend,
    isArray                     = Array.isArray,

    extractDependencies         = require('./transforms/deps'),
    jsonToCommonJS              = require('./transforms/json')

function mergeInto(target, source) {
  if (!source) return target
  var result = extend({}, target)
  for (var k in source) {
    var t = result[k], s = source[k]
    if (isArray(t) && isArray(s))
      result[k] = t.concat(s)
    else if (isObject(t) && isObject(s))
      result[k] = mergeInto(t, s)
    else
      result[k] = s
  }
  return result
}

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
      p.resolve({id: filename, package: pkg})
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
  return aggregate(asStream(mod.source).pipe(transform(mod.id)))
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
  return asPromise(transform(mod, opts)).then(mergeInto.bind(null, mod))
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
  if (!isString(transform)) return asPromise(transform)

  return transformResolve(transform, {basedir: path.dirname(mod.id)})
    .fail(function() {
      return transformResolve(transform, {basedir: process.cwd()})
    })
    .then(function(res) {
      if (!res)
        throw new Error([
          'cannot find transform module ', transform,
          ' while transforming ', mod.id
        ].join(''))
      return require(res.id)
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
  mod = clone(mod)
  delete mod.package
  delete mod.sourcePromise
  if (!mod.deps)
    mod.deps = {}
  if (Buffer.isBuffer(mod.source))
    mod.source = mod.source.toString()
  return mod
}

function readModuleSource(mod) {
  if (mod.source) return asPromise(mod)
  var promise = mod.sourcePromise || aggregate(fs.createReadStream(mod.id))
  return promise.then(function(source) {
    mod.source = source
    return mod
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

  if (opts.extensions) opts.extensions.unshift('.js')

  extend(opts, {
    resolve: function(id, parent) {
      if (opts.filter && !opts.filter(id))
        return asPromise({id: false})
      else
        return resolver(id, parent)
    },
    resolveDeps: function(ids, parent) {
      var result = {},
          resolutions = all(ids.map(function(id) {
            return opts.resolve(id, parent).then(function(r) {result[id] = r.id})
          }))
      return resolutions.then(function() { return result })
    }
  })

  var output = through(),
      basedir = opts.basedir || process.cwd(),
      resolve = resolveWith.bind(null, browserResolve),
      resolved = {},
      seen = {},
      entries = [].concat(mains).filter(Boolean).map(makeMainModule)

  all(entries.map(function(mod) {return walk(mod, {id: '/'})}))
    .fail(output.emit.bind(output, 'error'))
    .fin(output.queue.bind(output, null))

  output.asPromise = function() { return aggregate(this) }

  return output

  function emit(mod) {
    output.queue(moduleToResult(mod))
    return mod
  }

  function walk(mod, parent) {
    if (isString(mod)) mod = resolved[mod]
    if (seen[mod.id]) return
    seen[mod.id] = true

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

  function makeMainModule(m) {
    var mod = {entry: true}

    if (typeof m.pipe === 'function') {
      mod.id = path.join(basedir, rng(8).toString('hex') + '.js')
      mod.sourcePromise = aggregate(m)
    } else {
      mod.id = path.resolve(m)
    }
    return mod
  }

  // Wrapper around browser-resolve which passes configurations
  function resolver(id, parent) {
    var relativeTo = {
      packageFilter: opts.packageFilter,
      extensions: opts.extensions,
      modules: opts.modules,
      paths: [],
      filename: parent.id,
      package: parent.package
    }
    return resolve(id, relativeTo)
      .then(function(r) { return resolved[r.id] = r })
      .fail(function(err) {
        err.message += [', module required from', parent.id].join(' ')
        throw err

      })
  }

  // Allows to store module and package definitions in a opts.cache and
  // opts.packageCache respectively, this is how module-deps does it
  function checkExternalCache(mod, parent) {
    if (!(opts.cache && opts.cache[parent.id])) return
    var id = opts.cache[parent.id].deps[mod.id]
    return opts.cache[id]
  }

  function isTopLevel(mod) {
    return entries.some(function (entry) {
      return path.relative(path.dirname(entry.id), mod.id)
        .split('/').indexOf('node_modules') < 0
    })
  }

  // Apply global and per-package transforms on a module
  // It automatically inserts extractDependencies transform
  function applyTransforms(mod) {
    var txs = [], p = readModuleSource(mod)

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
