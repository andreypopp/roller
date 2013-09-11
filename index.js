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
      mod.stream = m
    } else {
      var filename = path.resolve(m)
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
  }

  function walk(cur, parent) {
    return ((!cur.filename && cur.id) ?
      resolver(cur.id, parent).then(_.extend.bind(null, cur)) :
      q.resolve(cur))
    .then(function(cur) {
      if (seen[cur.filename]) return
      seen[cur.filename] = true
      if (!cur.stream) cur.stream = fs.createReadStream(cur.filename)
      return applyTransforms(cur)
      .then(function(source) {
        cur.source = Buffer.isBuffer(source) ? source.toString() : source
        var deps = (opts.noParse && opts.noParse.indexOf(cur.filename) > -1) ?
          [] : detective(source)
        return q.all(deps.map(function(id) {
          return ((opts.filter && !opts.filter(id)) ?
            q.resolve({id: id, filename: false}) : resolver(id, cur))
        }))
      })
      .then(function(deps) {
        deps.forEach(function(dep) { cur.deps[dep.id] = dep.filename })
        var result = {id: cur.filename, source: cur.source, deps: cur.deps}
        if (cur.entry) result.entry = true
        output.queue(result)
        return q.all(Object.keys(cur.deps)
          .filter(function(depId) { return cur.deps[depId] })
          .map(function(depId) { return walk({id: depId, deps: {}}, cur) }))
      })
    })
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

  function applyTransforms(cur) {
    var isTopLevel = entries.some(function (entry) {
          return path.relative(path.dirname(entry.filename), cur.filename)
            .split('/').indexOf('node_modules') < 0
        }),
        transforms = [],
        stream = cur.stream

    if (isTopLevel) transforms = transforms.concat(opts.transform)
    if (cur.package) transforms = transforms.concat(getTransform(cur.package))
    return q.all(transforms.filter(Boolean).map(loadTransform.bind(null, cur)))
      .then(function(transforms) {
        transforms.forEach(function(t) {stream = stream.pipe(t(cur.filename))})
        return aggregate(stream)
      })
  }
}
