"use strict";

var parse   = require('css-parse'),
    unique  = require('underscore').unique

function isImportRule(r) {
  return (r.type === 'import') && (!/^url\(/.exec(r.import))
}

function unquote(str) {
  if (str[0] === "'" || str[0] === '"')
    str = str.slice(1, str.length - 1)
  return str
}

module.exports = function(mod, opts) {
  if (!/.*\.css/.exec(mod.filename)) return

  var css = parse(mod.source.toString()),
      deps = css.stylesheet.rules
        .filter(isImportRule)
        .map(function(r) { return unquote(r.import) })

  return mod.resolveMany(unique(deps))
    .then(function(deps) { return {deps: deps} })
}
