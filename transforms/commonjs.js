var q         = require('kew'),
    detective = require('detective')

module.exports = function(mod, opts) {

  if (opts.noParse && opts.noParse.indexOf(mod.filename) > -1) return

  var deps = detective(mod.source).map(function(id) {
    var resolved
    if (opts.filter && !opts.filter(id))
      resolved = q.resolve({id: id, filename: false})
    else
      resolved = mod.resolve(id)

    return resolved.then(function(dep) { mod.deps[dep.id] = dep.filename })
  })

  return q.all(deps).then(function() { return mod })
}

