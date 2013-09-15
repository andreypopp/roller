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

  this._injections = [] // modules we inject into bundle
  this._pipeline = []   // additional pipeline streams
  this._exposed = []    // exposed name which should not be mangled
}

defineLazyProperty(Bundler.prototype, 'entries', function() {
  return this.graph.entries.map(function(m) {return m.id})
})

Bundler.prototype = {

  expose: function(id) {
    this._exposed.push(id)
    return this
  },

  inject: function(mod, opts) {
    this._injections.push(mod)
    if (opts && opts.expose)
      this.expose(mod.id)
    return this
  },

  through: function(func) {
    this._pipeline.push(through(func))
    return this
  },

  getPipeline: function() {
    var pipeline = this._pipeline.slice(),
        seen = false

    if (this.opts.insertGlobals)
      pipeline.push(insertGlobals(this.entries))

    if (!this.opts.exposeAll)
      pipeline.push(this._hashIDs())

    pipeline.push(depsSort())
    pipeline.push(pack({raw: true, prelude: this.opts.prelude}))
    pipeline.push(this._wrapBundle())

    return pipeline
  },

  getGraphStream: function() {
    var output = through()

    output.pause()
    process.nextTick(output.resume.bind(output))

    this._injections.forEach(output.queue.bind(output))

    for (var key in this.graph) {
      var mod = this.graph[key]
      if (this.opts.debug) {
        mod = clone(mod)
        mod.sourceFile = mod.id
        mod.sourceRoot = 'file://localhost'
      }
      output.queue(mod)
    }

    output.queue(null)
    return output
  },

  _wrapBundle: function() {
    var seen = false
    return through(
      function(chunk) {
        if (!seen) {
          seen = true
          this.queue('require = ')
        }
        this.queue(chunk)
      },
      function() {
        if (!seen) {
          seen = true
          this.queue('require = ')
        }
        this.queue('\n;')
        this.queue(null)
      })
  },

  _hashIDs: function() {
    var self = this

    return through(function(mod) {
      mod = clone(mod)
      if (self._exposed.indexOf(mod.id) === -1)
        mod.id = hash(mod.id)
      for (var id in mod.deps)
        if (mod.deps[id] && self._exposed.indexOf(mod.deps[id]) === -1)
          mod.deps[id] = hash(mod.deps[id])
      this.queue(mod)
    })
  },

  toStream: function() {
    var pipeline = combine.apply(null, this.getPipeline())
    return this.getGraphStream().pipe(pipeline)
  },

  toPromise: function() {
    return aggregate(this.toStream())
  }
}

function hash(what) {
  return crypto.createHash('md5').update(what).digest('base64').slice(0, 6)
}
