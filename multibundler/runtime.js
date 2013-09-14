var modulesMap = require('roller/runtime/bundles'),
    fetchedBundles = {},
    loadedModules = {}

module.exports = window.__runtime = {
  require: function(id) {
    return require(id)
  },

  load: function(src, callback) {
      var scripts = document.head.getElementsByTagName('script');
      for (var i = 0; i < scripts.length; i++) {
        if (scripts[i].src == src) return 'loaded'
      }
      var scr = document.head.appendChild(document.createElement('script'));
      scr.async = true
      scr.onload = callback
      scr.src = src
  },

  require_async: function(id, callback) {
    var bundle = modulesMap[id]

    if (!bundle)
      return callback(new Error('no known bundle with ' + id + ' module defined'))

    if (fetchedBundles[bundle])
      return callback(null, require(id))

    this.load(bundle + '.js', function() {
      callback(null, this.require(id))
    }.bind(this))
  },

  bundleLoaded: function(newRequire) {
    this.require = newRequire
  }
}

require('entry')
