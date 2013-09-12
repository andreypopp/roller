"use strict";

var path        = require('path'),
    through     = require('through'),
    _           = require('underscore'),
    values      = _.values,

    packJS      = require('browser-pack'),
    asStream    = require('as-stream'),
    makeGraph   = require('./index')

function asIndex(graph) {
  var index = {}
  graph.forEach(function(mod) { index[mod.id] = mod })
  return index
}

function traverseGraphFrom(graph, fromId, func) {
  var toTraverse = [[graph[fromId]]],
      args,
      mod

  while (toTraverse.length > 0) {
    args = toTraverse.shift()
    func.apply(null, args)

    mod = args[0]
    if (mod.deps)
      for (var depId in mod.deps)
        if (mod.deps[depId])
          toTraverse.push([graph[mod.deps[depId]], depId, mod])
  }
}

module.exports = function(spec, opts) {
  var common  = {js: through(), css: through()},
      streams = {__common__: common}

  for (var name in spec) {
    spec[name] = path.resolve(spec[name])
    streams[name] = {js: through(), css: through()}
  }

  makeGraph(values(spec), opts).asPromise().then(function(graph) {
    graph = asIndex(graph)
    var seen = {}, // {moduleName: number of references from different apps}
        commonModules = [],
        modules

    // see if we have modules which we refernce several times from different
    // bundles
    for (var name in spec)
      traverseGraphFrom(graph, spec[name], function(mod) {
        seen[mod.id] = seen[mod.id] ? seen[mod.id] + 1 : 1
      })

    // pack common modules
    for (var id in seen)
      if (seen[id] > 1 && !graph[id].entry) {
        commonModules.push(graph[id])   
      }
    asStream.apply(null, commonModules)
      .pipe(packJS({raw: true}))
      .pipe(common.js)

    // pack app bundles
    for (var name in spec) {
      modules = []
      traverseGraphFrom(graph, spec[name], function(mod) {
        if (seen[mod.id] > 1) return // it's in common bundle
        modules.push(mod)
      })
      asStream.apply(null, modules)
        .pipe(packJS({raw: true}))
        .pipe(streams[name].js)
    }

  }).end()


  return streams
}
