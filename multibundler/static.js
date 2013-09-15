var path            = require('path'),
    crypto          = require('crypto'),
    through         = require('through'),
    values          = require('lodash-node/modern/objects/values'),
    Graph           = require('dgraph').Graph,
    Bundler         = require('dgraph-bundler').Bundler,
    multibundler    = require('./index')

var commonSubgraph  = multibundler.commonSubgraph,
    except          = multibundler.except,
    subgraphFor     = multibundler.subgraphFor

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
