"use strict";

var detective = require('detective')

module.exports = function(mod, g) {
  if (g.opts.noParse && g.opts.noParse.indexOf(mod.filename) > -1) return
  var deps = detective(mod.source, {word: 'require_async'})

  return g.resolveDeps(deps, mod)
    .then(function(deps) { return {deps: deps, async_deps: deps} })
}

