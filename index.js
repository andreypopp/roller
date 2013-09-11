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
    aggregate       = require('stream-aggregate-promise');

function asStream(str) {
  if (typeof str.pipe === 'function') return str
  var stream = through()
  stream.pause()
  process.nextTick(function () { stream.resume() })
  stream.queue(str)
  stream.queue(null)
  return stream
}

function resolveWith(resolve, id, opts) {
  var p = q.defer()
  resolve(id, opts, function(err, filename, pkg) {
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
    var mod = {entry: true, deps: {}}
    if (typeof m.pipe === 'function') {
      mod.filename = path.join(basedir, rng(8).toString('hex') + '.js')
      mod.sourcePromise = aggregate(m)
    } else {
      var filename = path.resolve(m)
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

  function checkCache(cur, parent) {
    if (!(opts.cache && opts.cache[parent.filename])) return
    var curFilename = opts.cache[parent.filename].deps[cur.id]
    var result = opts.cache[curFilename]
    if (!result) return
    return {id: cur.id, filename: curFilename,
      deps: result.deps, source: result.source, entry: result.entry,
      package: opts.packageCache && opts.packageCache[result.id]}
  }

  function walk(cur, parent) {
    var cached = checkCache(cur, parent)
    if (cached) {
      output.emit(moduleToResult(cached))
      return walkDeps(cached, parent)
    }
    return ((!cur.filename && cur.id) ?
      resolver(cur.id, parent).then(_.extend.bind(null, cur)) :
      q.resolve(cur))
    .then(function(cur) {
      if (seen[cur.filename]) return
      seen[cur.filename] = true

      if (!cur.sourcePromise)
        cur.sourcePromise = aggregate(fs.createReadStream(cur.filename))

      return applyTransforms(cur).then(function(cur) {
        if (Buffer.isBuffer(cur.source)) cur.source = cur.source.toString()
        output.queue(moduleToResult(cur))
        return walkDeps(cur)
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

  function walkDeps(cur) {
    return q.all(Object.keys(cur.deps)
      .filter(function(depId) { return cur.deps[depId] })
      .map(function(depId) { return walk({id: depId, deps: {}}, cur) }))
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

  function loadTransform(cur, transform) {
    if (!_.isString(transform)) return q.resolve(transform)

    return transformResolve(transform, {basedir: path.dirname(cur.filename)})
      .fail(function() {
        return transformResolve(transform, {basedir: process.cwd()})
      })
      .then(function(res) {
        if (!res)
          throw new Error([
            'cannot find transform module ', transform,
            ' while transforming ', cur.filename
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

  function applyTransforms(cur) {
    var isTopLevel = entries.some(function (entry) {
          return path.relative(path.dirname(entry.filename), cur.filename)
            .split('/').indexOf('node_modules') < 0
        }),
        transforms = [],
        point = cur.sourcePromise.then(function(source) {
          cur.source = source
          return cur
        })

    if (isTopLevel) transforms = transforms.concat(opts.transform)
    if (cur.package) transforms = transforms.concat(getTransform(cur.package))
    transforms.push(extractDeps)
    return q.all(transforms.filter(Boolean).map(loadTransform.bind(null, cur)))
      .then(function(transforms) {
        transforms.forEach(function(t) {
          point = point.then(doTransform.bind(null, t))
        })
        return point
      })
  }
}
