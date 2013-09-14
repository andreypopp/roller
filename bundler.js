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
  this.graph = graph
  this.opts = opts || {}
  this.injections = []
  this.pipeline = []
  this.exposed = []
}

defineLazyProperty(Bundler.prototype, 'entries', function() {
  return this.graph.entries.map(function(m) {return m.id})
})

Bundler.prototype = {

  expose: function(id) {
    this.exposed.push(id)
    return this
  },

  inject: function(mod, opts) {
    this.injections.push(mod)
    if (opts && opts.expose)
      this.expose(mod.id)
    return this
  },

  through: function(func) {
    this.pipeline.push(through(func))
    return this
  },

  getPacker: function() {
    return pack({raw: true, prelude: this.opts.prelude})
  },

  getPipeline: function() {
    var pipeline = this.pipeline.concat([depsSort()])

    if (this.opts.insertGlobals)
      pipeline.push(insertGlobals(this.entries))

    if (!this.opts.exposeAll)
      pipeline.push(this.hashIDs())

    return pipeline
  },

  getGraphStream: function() {
    var output = through()

    output.pause()
    process.nextTick(output.resume.bind(output))

    this.injections.forEach(output.queue.bind(output))

    for (var key in this.graph)
      output.queue(this.graph[key])
    output.queue(null)
    return output
  },

  hashIDs: function() {
    var self = this

    return through(function(mod) {
      mod = clone(mod)
      if (self.exposed.indexOf(mod.id) === -1)
        mod.id = hash(mod.id)
      for (var id in mod.deps)
        if (mod.deps[id] && self.exposed.indexOf(mod.deps[id]) === -1)
          mod.deps[id] = hash(mod.deps[id])
      this.queue(mod)
    })
  },

  toStream: function() {
    var pipeline = this.getPipeline()

    pipeline.push(this.getPacker())

    return this.getGraphStream().pipe(combine.apply(null, pipeline))
  },

  toPromise: function() {
    return aggregate(this.toStream())
  }
}

function hash(what) {
  return crypto.createHash('md5').update(what).digest('base64').slice(0, 6)
}
