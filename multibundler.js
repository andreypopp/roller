"use strict";

var path        = require('path'),
    through     = require('through'),
    _           = require('underscore'),
    depsSort    = require('deps-sort'),
    browserPack = require('browser-pack'),
    duplex      = require('duplexer'),
    makeGraph   = require('./index')

module.exports = function(spec, opts) {
  var output = {__common__: {js: packJS(), css: packCSS()}}

  for (var name in spec) {
    spec[name] = path.resolve(spec[name])
    output[name] = {js: packJS(), css: packCSS()}
  }

  makeGraph(_.values(spec), opts).asPromise().then(function(graph) {
    graph = asIndex(graph)
    var seen = {}

    // see if we have modules which we refernce several times from different
    // bundles
    for (var name in spec)
      traverseGraphFrom(graph, spec[name], function(mod) {
        seen[mod.id] || (seen[mod.id] = [])
        if (!mod.entry) seen[mod.id].push(name)
      })

    // pack common modules
    for (var id in seen)
      if (seen[id].length > 1)
        output.__common__.js.write(graph[id])
    output.__common__.js.end()
    output.__common__.css.end()

    // pack app bundles
    for (var name in spec) {
      traverseGraphFrom(graph, spec[name], function(mod) {
        if (seen[mod.id].length > 1) return // it's in common bundle
        if (/.*\.(css|less|sass|scss|styl)/i.exec(mod.id))
          output[name].css.write(mod)
        else
          output[name].js.write(mod)
      })
      output[name].js.end()
      output[name].css.end()
    }

  }).end()

  return output
}

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

function sorted(stream) {
  var sorter = depsSort()
  sorter.pipe(stream)
  return duplex(sorter, stream)
}

function packCSS() {
  return sorted(through(function(mod) { this.queue(mod.source) }))
}

function packJS() {
  return sorted(browserPack({raw: true}))
}
