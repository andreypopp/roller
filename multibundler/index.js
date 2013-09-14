"use strict";

var assign  = require('lodash-node/modern/objects/assign'),
    unique  = require('lodash-node/modern/arrays/uniq')

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
        toTraverse.unshift([graph[mod.deps[depId]], depId, mod])
  }
}

module.exports = {
  traverse: traverse,
  subgraphFor: subgraphFor,
  commonSubgraph: commonSubgraph,
  except: except
}
