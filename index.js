/* jshint asi: true, expr: true, globalstrict: true */
/* global require, Buffer, process, module */
"use strict";

var fs              = require('fs'),
    path            = require('path'),
    rng             = require('crypto').rng,
    _               = require('underscore'),
    q               = require('kew'),
    through         = require('through'),
    nodeResolve     = require('resolve'),
    browserResolve  = require('browser-resolve'),
    detective       = require('detective'),
    aggregate       = require('stream-aggregate-promise'),
    asStream        = require('as-stream')

function resolveWith(resolve, id, parent) {
  var p = q.defer()
  resolve(id, parent, function(err, filename, pkg) {
    err ? p.reject(err) : p.resolve({id: id, filename: filename, package: pkg})
  })
  return p
}

module.exports = function(mains, opts) {
  opts = opts || {}

  var output = through(),
      basedir = opts.basedir || process.cwd(),
      resolve = resolveWith.bind(null, opts.resolve || browserResolve),
      transformResolve = resolveWith.bind(null, nodeResolve),
      cache = {},
      seen = {},
      entries = [].concat(mains).filter(Boolean).map(makeModule)

  q.all(entries.map(function(mod) {return walk(mod, {filename: '/', id: '/'})}))
    .fail(output.emit.bind(output, 'error'))
    .fin(output.queue.bind(output, null))

  return output

  function makeModule(m) {
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

  function walkDeps(mod) {
    return q.all(Object.keys(mod.deps)
      .filter(function(depId) { return mod.deps[depId] })
      .map(function(depId) { return walk({id: depId, deps: {}}, mod) }))
  }

  function getTransform(pkg) {
    if (opts.transformKey) {
      var n = pkg
      opts.transformKey.forEach(function (key) {
        if (n && typeof n === 'object') n = n[key]
      })
      return [].concat(n).filter(Boolean)
    }
  }

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

  function doTransform(transform, mod) {
    if (transform.length === 1) {
      return aggregate(asStream(mod.source).pipe(transform(mod.filename)))
        .then(function(source) {
          mod.source = source
          return mod
        })
    } else {
      return q.resolve(transform(mod.filename, mod))
        .then(function(transformed) {
          if (transformed.source) mod.source = transformed.source
          if (transformed.deps) mod.deps = _.extend(mod.deps, transformed.deps)
          return mod
        })
    }
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

    if (isTopLevel) txs = txs.concat(opts.transform)
    if (mod.package) txs = txs.concat(getTransform(mod.package))

    return q.all(txs.filter(Boolean).map(loadTransform.bind(null, mod)))
      .then(function(txs) {
        txs.forEach(function(t) { p = p.then(doTransform.bind(null, t)) })
        return p
      })
  }
}
