/* global require, Buffer, process, module */
"use strict";

var detective = require('detective')

module.exports = function(mod, opts) {
  if (opts.noParse && opts.noParse.indexOf(mod.filename) > -1) return

  return mod.resolveMany(detective(mod.source))
    .then(function(deps) { return {deps: deps} })
}

