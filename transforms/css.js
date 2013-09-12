var parse   = require('css-parse'),
    all     = require('kew').all,
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

  var deps = {},
      css = parse(mod.source.toString()),
      resolutions = unique(css.stylesheet.rules
        .filter(isImportRule)
        .map(function(r) { return unquote(r.import) }))
        .map(function(r) { return mod.resolve(r) })

  return all(resolutions)
    .then(function(resolved) {
      resolved.forEach(function(r) { deps[r.id] = r })
      return {deps: deps}
    })
}
