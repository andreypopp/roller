"use strict";

var path            = require('path'),
    crypto          = require('crypto'),
    through         = require('through'),
    _               = require('underscore'),
    clone           = _.clone,
    extend          = _.extend,
    values          = _.values,
    unique          = _.unique,
    depsSort        = require('deps-sort'),
    browserPack     = require('browser-pack'),
    combine         = require('stream-combiner'),
    browserBuiltins = require('browser-builtins'),
    insertGlobals   = require('insert-module-globals'),
    collectGraph    = require('./graph')

module.exports = function(spec, opts) {
  var entries = values(spec).map(function(p) { return path.resolve(p) }),
      output = {common: {js: combine(insertGlobals(entries), packJS())}}

  for (var name in spec) {
    spec[name] = path.resolve(spec[name])
    output[name] = {js: packJS()}
  }

  opts.modules = opts.modules || {}
  extend(opts.modules, browserBuiltins)

  collectGraph(entries, opts).asPromise()
    .then(function(graph) {
      graph = asIndex(graph)

      var common = commonSubgraph(graph, entries)

      packGraph(common, {exposeAll: true})
        .pipe(output.common.js)

      for (var name in spec)
        packGraph(except(subgraphFor(graph, spec[name]), common))
          .pipe(output[name].js)

    })
    .end()

  return output
}

function commonSubgraph(graph, entries) {
  var result = {}

  // XXX: this can be done more efficiently if we just break traversing graph on
  // modules which are already referenced twice, then we need to mark its deps
  // as common modules automatically
  entries.forEach(function(entry) {
    traverse(graph, entry, function(mod, ref, parent) {
      if (!result[mod.id]) {
        result[mod.id] = extend({entries: [], from: {}}, mod)
      }
      if (!mod.entry) {
        result[mod.id].entries.push(entry)
        result[mod.id].from[parent.id] = ref
      }
    })
  })

  Object.keys(result).forEach(function(id) {
    var mod = result[id]
    mod.entries = unique(mod.entries)
    if (result[id].entries.length < 2) delete result[id]
  })

  return result
}

function subgraphFor(graph, entry) {
  var result = {}
  traverse(graph, entry, function(mod, ref, parent) {
    result[mod.id] = mod
  })
  return result
}

function except(a, b) {
  var result = {}
  for (var key in a)
    if (!b[key]) result[key] = a[key]
  return result
}

function packGraph(graph, opts) {
  var output = through(),
      mod

  output.pause()
  process.nextTick(output.resume.bind(output))

  opts = opts || {}

  for (var id in graph) {
    mod = graph[id]
    output.queue({
      id: id,
      deps: mod.deps,
      source: mod.source,
      entry: mod.entry
    })
  }
  if (opts.exposeAll)
    output.queue({
      id: random(8),
      deps: {},
      entry: true,
      source: 'window.require = require'
    })
  output.queue(null)
  return output
}

function asIndex(graph) {
  var index = {}
  graph.forEach(function(mod) { index[mod.id] = mod })
  return index
}

function traverse(graph, fromId, func) {
  var toTraverse = [[graph[fromId]]],
      args,
      mod

  // XXX: no bulletproofness against cycles
  while (toTraverse.length > 0) {
    args = toTraverse.shift()
    mod = args[0]
    if (!mod) continue

    func.apply(null, args)

    if (mod && mod.deps)
      for (var depId in mod.deps)
        if (mod.deps[depId]) {
          toTraverse.push([graph[mod.deps[depId]], depId, mod])
        }
  }
}

function mangleID() {
  return through(function(mod) {
    mod = clone(mod)
    mod.id = hash(mod.id)
    if (mod.deps)
      for (var id in mod.deps)
        mod.deps[id] = hash(mod.deps[id])
    this.queue(mod)
  })
}

function packJS(opts) {
  return combine(mangleID(), depsSort(), browserPack({raw: true}))
}

function hash(what) {
  return crypto.createHash('md5').update(what).digest('base64').slice(0, 6)
}

function random(n) {
  return crypto.rng(n).toString('hex')
}
