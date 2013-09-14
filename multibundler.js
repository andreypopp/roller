"use strict";

var path            = require('path'),
    crypto          = require('crypto'),
    through         = require('through'),
    assign          = require('lodash.assign'),
    values          = require('lodash.values'),
    unique          = require('lodash.uniq'),
    Graph           = require('./graph').Graph,
    Bundler         = require('./bundler').Bundler

module.exports = function(spec, opts) {
  var entries = values(spec).map(function(p) { return path.resolve(p) }),
      output = {common: {js: through()}}

  for (var name in spec) {
    spec[name] = path.resolve(spec[name])
    output[name] = {js: through()}
  }

  new Graph(entries, opts).toPromise()
    .then(function(graph) {
      var common = commonSubgraph(graph, entries),
          exposerID = crypto.rng(8).toString('hex')

      common[exposerID] = {
        id: exposerID,
        deps: {},
        entry: true,
        source: 'window.require = require'
      }

      new Bundler(common, {insertGlobals: true}).toStream()
        .pipe(output.common.js)

      for (var name in spec)
        new Bundler(except(subgraphFor(graph, spec[name]), common)).toStream()
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
        result[mod.id] = assign({entries: []}, mod)
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
