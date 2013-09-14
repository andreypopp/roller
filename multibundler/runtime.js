var modulesMap = require('roller/runtime/bundles'),
    fetchedBundles = {}

module.exports = {

  require: function(id) {
    return require(id)
  },

  fetch: function(src, callback) {
      var scripts = document.head.getElementsByTagName('script');
      for (var i = 0; i < scripts.length; i++) {
        if (scripts[i].src == src) return 'loaded'
      }
      var scr = document.head.appendChild(document.createElement('script'));
      scr.async = true
      scr.onload = callback
      scr.src = src
  },

  load: function(id, callback) {
    var bundle = modulesMap[id]

    if (!bundle)
      return callback(new Error('no known bundle with ' + id + ' module defined'))

    if (fetchedBundles[bundle])
      return callback(null, require(id))

    this.fetch(bundle + '.js', function() {
      fetchedBundles[bundle] = true
      callback(null, this.require(id))
    }.bind(this))
  },

  bundleLoaded: function(newRequire, entries) {
    this.require = newRequire
    for(var i=0; i<entries.length; i++)
      newRequire(entries[i])
  }
}
