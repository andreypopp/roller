var path                = require('path'),
    fs                  = require('fs'),
    crypto              = require('crypto'),
    through             = require('through'),
    isEmpty             = require('lodash-node/modern/objects/isEmpty'),
    values              = require('lodash-node/modern/objects/values'),
    assign              = require('lodash-node/modern/objects/assign'),
    clone               = require('clone'),
    Graph               = require('dgraph').Graph,
    Bundler             = require('dgraph-bundler').Bundler,
    hash                = require('dgraph-bundler').hash,
    asStream            = require('as-stream'),
    multibundler        = require('./index'),
    asyncDepsTransform  = require('../transforms/async_deps')

var commonSubgraph      = multibundler.commonSubgraph,
    except              = multibundler.except,
    subgraphFor         = multibundler.subgraphFor,
    traverse            = multibundler.traverse

var runtime = fs.readFileSync(path.join(__dirname, 'runtime.js'), 'utf8')
var prelude = fs.readFileSync(path.join(__dirname, 'prelude.js'), 'utf8')

module.exports = function(entry, opts) {
  entry = path.resolve(entry)

  opts.transform = opts.transform || []
  opts.transform.push(asyncDepsTransform)

  return new Graph(entry, opts).toPromise().then(function(graph) {
    var output = {bootstrap: {js: through()}},
        points = splitPoints(graph, entry),
        splitted = splitGraph(graph, points),
        bootstrap = subgraphFor(splitted, entry),
        mapping = {}

    function deltaBundleName(from, to) {
      from = from === entry ? 'bootstrap' : hash(from)
      to = hash(to)
      return from + '_' + to
    }

    function updateMapping(bundleName, graph) {
      Object.keys(graph).map(hash).forEach(function(id) {
        mapping[id] = bundleName
      })
    }

    function mapAsyncDeps(mod) {
      mod = clone(mod)
      assign(mod.deps, mod.async_deps)
      this.queue(mod)
    }

    for (var p in points) {
      var pGraph = p === entry ? bootstrap : subgraphFor(splitted, p)
      for (var sRef in points[p]) {
        var s = points[p][sRef],
            bundleName = deltaBundleName(p, s),
            stream = output[bundleName] = {js: through()},
            sGraph = except(subgraphFor(splitted, s), pGraph)

        updateMapping(bundleName, sGraph)
        new Bundler(asStream.apply(null, values(sGraph)), {prelude: prelude, debug: opts.debug})
          .through(mapAsyncDeps)
          .toStream()
          .pipe(stream.js)
      }
    }

    updateMapping('bootstrap', bootstrap)

    new Bundler(asStream.apply(null, values(bootstrap)), {insertGlobals: true, prelude: prelude, debug: opts.debug})
      .through(mapAsyncDeps)
      .inject({
        id: 'roller/runtime/loader',
        deps: {},
        entry: true,
        source: runtime
      }, {expose: true})
      .inject({
        id: 'roller/runtime/modules',
        deps: {},
        source: 'module.exports = ' + JSON.stringify(mapping) + ';'
      }, {expose: true})
      .toStream()
      .pipe(output.bootstrap.js)

    return output
  })
}

function splitGraph(graph, points) {
  var result = assign({}, graph)
  for (var id in points) {
    result[id] = clone(result[id])
    for (var splitId in points[id]) {
      delete result[id].deps[splitId]
    }
  }
  return result
}

function splitPoints(graph, entry) {
  var result = {}
  traverse(graph, entry, function(mod, ref, parent) {
    if (!isEmpty(mod.async_deps))
      result[mod.id] = mod.async_deps
  })
  for (var k in result)
    values(result[k]).forEach(function(id) {
      if (!result[id])
        result[id] = {}
    })
  return result
}
