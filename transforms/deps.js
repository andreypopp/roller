"use strict";

var detective = require('detective')

module.exports = function(mod, opts) {
  if (opts.noParse && opts.noParse.indexOf(mod.id) > -1) return
  var deps = detective(mod.source)

  return opts.resolveDeps(deps, mod)
    .then(function(deps) { return {deps: deps} })
}

