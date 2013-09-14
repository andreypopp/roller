var crypto              = require('crypto'),
    clone               = require('clone'),
    pack                = require('browser-pack'),
    through             = require('through'),
    depsSort            = require('deps-sort'),
    insertGlobals       = require('insert-module-globals'),
    combine             = require('stream-combiner'),
    aggregate           = require('stream-aggregate-promise'),
    defineLazyProperty  = require('lazy-property')

module.exports = function(graph) {
  return new Bundler(graph, opts).toStream()
}
module.exports.Bundler = Bundler
module.exports.hash = hash

function Bundler(graph, opts) {
  var self = this

  self.graph = graph
  self.opts = opts || {}
}

defineLazyProperty(Bundler.prototype, 'entries', function() {
  return this.graph.entries.map(function(m) {return m.id})
})

Bundler.prototype = {

  getPacker: function() {
    return pack({raw: true})
  },

  getPipeline: function() {
    var self = this,
        pipeline = [depsSort(), mangleID()]

    if (self.opts.insertGlobals)
      pipeline.push(insertGlobals(self.entries))

    return pipeline
  },

  getGraphsStream: function() {
    var self = this,
        output = through()

    output.pause()
    process.nextTick(output.resume.bind(output))

    for (var key in self.graph)
      output.queue(self.graph[key])
    output.queue(null)
    return output
  },

  toStream: function() {
    var self = this,
        pipeline = self.getPipeline()

    pipeline.push(self.getPacker())

    return self.getGraphsStream().pipe(combine.apply(null, pipeline))
  },

  toPromise: function() {
    return aggregate(this.toStream())
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

function hash(what) {
  return crypto.createHash('md5').update(what).digest('base64').slice(0, 6)
}
