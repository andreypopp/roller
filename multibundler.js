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
    Graph           = require('./graph').Graph

module.exports = function(spec, opts) {
  var entries = values(spec).map(function(p) { return path.resolve(p) }),
      output = {common: {js: packJS()}}

  for (var name in spec) {
    spec[name] = path.resolve(spec[name])
    output[name] = {js: packJS()}
  }

  opts.modules = extend({}, browserBuiltins, opts.modules)

  new Graph(entries, opts).toPromise()
    .then(asIndex)
    .then(function(graph) {
      var common = commonSubgraph(graph, entries)

      packGraph(common, {exposeAll: true})
        .pipe(insertGlobals(entries))
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

  entries.forEach(function(entry) {
    traverse(graph, entry, function(mod) {
      if (mod.entry) return
      if (!result[mod.id])
        result[mod.id] = extend({entries: []}, mod)
      result[mod.id].entries.push(entry)
    })
  })

  for (var id in result) {
    var mod = result[id]
    mod.entries = unique(mod.entries)
    if (mod.entries.length < 2) delete result[id]
  }

  return result
}

function subgraphFor(graph, entry) {
  var result = {}
  traverse(graph, entry, function(mod) {result[mod.id] = mod})
  return result
}

function except(a, b) {
  var result = {}
  for (var key in a)
    if (!b[key]) result[key] = a[key]
  return result
}

function packGraph(graph, opts) {
  var output = through()

  output.pause()
  process.nextTick(output.resume.bind(output))

  for (var id in graph)
    output.queue(graph[id])

  if (opts && opts.exposeAll)
    output.queue({
      id: crypto.rng(8).toString('hex'),
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
      seen = {}

  while (toTraverse.length > 0) {
    var args = toTraverse.shift()
    var mod = args[0]

    if (!mod || seen[mod.id]) continue
    seen[mod.id] = true

    func.apply(null, args)
    for (var depId in mod.deps)
      if (mod.deps[depId])
        toTraverse.push([graph[mod.deps[depId]], depId, mod])
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

function packJS() {
  return combine(mangleID(), depsSort(), browserPack({raw: true}))
}

function hash(what) {
  return crypto.createHash('md5').update(what).digest('base64').slice(0, 6)
}
