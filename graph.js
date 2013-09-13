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
    toPromise                   = q.resolve,
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

function runStreamTransform(transform, mod) {
  return aggregate(asStream(mod.source).pipe(transform(mod.id)))
    .then(function(source) {
      mod.source = source
      return mod
    })
}

function runTransform(transform, mod, graph) {
  return toPromise(transform(mod, graph)).then(mergeInto.bind(null, mod))
}

function getTransform(pkg, key) {
  key.forEach(function (k) { if (pkg && typeof pkg === 'object') pkg = pkg[k] })
  return [].concat(pkg).filter(Boolean)
}

function loadTransform(mod, transform) {
  if (!isString(transform)) return toPromise(transform)

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

function Graph(mains, opts) {
  var self = this

  self.opts = opts || {}
  self.output = through()
  self.basedir = self.opts.basedir || process.cwd()
  self.resolveImpl = resolveWith.bind(null, self.opts.resolve || browserResolve)
  self.resolved = {}
  self.seen = {}
  self.entries = [].concat(mains).filter(Boolean).map(function(m) {
    var mod = {entry: true}
    if (typeof m.pipe === 'function') {
      mod.id = path.join(self.basedir, rng(8).toString('hex') + '.js')
      mod.sourcePromise = aggregate(m)
    } else {
      mod.id = path.resolve(m)
    }
    return mod
  })
}

Graph.prototype = {

  resolve: function(id, parent) {
    var self = this
    if (self.opts.filter && !self.opts.filter(id))
      return toPromise({id: false})
    else {
      var relativeTo = {
        packageFilter: self.opts.packageFilter,
        extensions: self.opts.extensions,
        modules: self.opts.modules,
        paths: [],
        filename: parent.id,
        package: parent.package
      }
      return self.resolveImpl(id, relativeTo)
        .then(function(r) { return self.resolved[r.id] = r })
        .fail(function(err) {
          err.message += [', module required from', parent.id].join(' ')
          throw err
        })
    }
  },

  resolveDeps: function(ids, parent) {
    var self = this
    var result = {},
        resolutions = all(ids.map(function(id) {
          return self.resolve(id, parent).then(function(r) {result[id] = r.id})
        }))
    return resolutions.then(function() { return result })
  },

  toStream: function() {
    var self = this
    all(self.entries.map(function(mod) {return self.walk(mod, {id: '/'})}))
      .fail(self.output.emit.bind(self.output, 'error'))
      .fin(self.output.queue.bind(self.output, null))
    return self.output
  },

  toPromise: function() {
    return aggregate(this.toStream())
  },

  walk: function(mod, parent) {
    var self = this
    if (isString(mod)) mod = self.resolved[mod]
    if (self.seen[mod.id]) return
    self.seen[mod.id] = true

    var cached = self.checkCache(mod, parent)
    if (cached) {
      self.emit(cached)
      return self.walkDeps(cached, parent)
    }

    return self.applyTransforms(mod)
      .then(self.emit.bind(self))
      .then(self.walkDeps.bind(self))
  },

  walkDeps: function(mod) {
    var self = this
    return all(Object.keys(mod.deps)
      .filter(function(id) { return mod.deps[id] })
      .map(function(id) { return self.walk(mod.deps[id], mod) }))
  },

  emit: function(mod) {
    var self = this
    self.output.queue(moduleToResult(mod))
    return mod
  },

  checkCache: function(mod, parent) {
    var self = this
    if (!(self.opts.cache && self.opts.cache[parent.id])) return
    var id = self.opts.cache[parent.id].deps[mod.id]
    return self.opts.cache[id]
  },

  readSource: function(mod) {
    if (mod.source) return toPromise(mod)
    var promise = mod.sourcePromise || aggregate(fs.createReadStream(mod.id))
    return promise.then(function(source) {
      mod.source = source
      return mod
    })
  },

  applyTransforms: function(mod) {
    var self = this,
        txs = [],
        p = self.readSource(mod),
        isTopLevel = self.entries.some(function (entry) {
      return path.relative(path.dirname(entry.id), mod.id)
        .split('/').indexOf('node_modules') < 0
    })

    if (isTopLevel)
      txs = txs.concat(self.opts.transform)

    if (mod.package && self.opts.transformKey)
      txs = txs.concat(getTransform(mod.package, self.opts.transformKey))

    txs = txs.filter(Boolean).map(loadTransform.bind(null, mod))
    txs.push(extractDependencies)
    txs.push(jsonToCommonJS)

    return all(txs).then(function(txs) {
      txs.forEach(function(t) {
        p = p.then(function(p) {
          if (t.length === 1)
            return runStreamTransform(t, p)
          else
            return runTransform(t, p, self)
        })
      })
      return p
    })
  }
}

module.exports = function(mains, opts) {
  return new Graph(mains, opts).toStream()
}
module.exports.Graph = Graph
