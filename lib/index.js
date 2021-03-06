'use strict';

var Promise = require('bluebird');
var CircularJSON = require('circular-json');
var crypto = require('crypto');

module.exports = Cacher;

/**
 * Constructor for cacher
 */
function Cacher(seq, red) {
  if (!(this instanceof Cacher)) {
    return new Cacher(seq, red);
  }
  this.method = 'find';
  this.options = {};
  this.seconds = 30;
  this.cacheHit = false;
  this.cachePrefix = 'cacher';
  this.sequelize = seq;
  this.redis = red;
  this.toBeDelKeys = {};
  this.redis.on("connect", function() {
    console.log('Redis server connected');
  });
  this.redis.on("end", function() {
    console.log('Redis server disconnected');
  });
  this.redis.on("reconnecting", function() {
    console.log('Reconnecting to Redis server');
  });
  this.redis.on("ready", function() {
    console.log('Redis server connection ready');
  });
  this.redis.on("error", function(err) {
    console.log('Error in redis server');
    console.error(err.toString());
  });
}

/**
 * Set model
 */
Cacher.prototype.model = function model(md) {
  this.md = this.sequelize.model(md);
  this.modelName = md;
  return this;
};

/**
 * Set cache prefix
 */
Cacher.prototype.prefix = function prefix(cachePrefix) {
  this.cachePrefix = cachePrefix;
  return this;
};

/**
 * Set redis TTL (in seconds)
 */
Cacher.prototype.ttl = function ttl(seconds) {
  this.seconds = seconds;
  return this;
};

/**
 * Create redis key
 */
Cacher.prototype.keySQL = function key(sql, options) {
  var hash = null;
  if (!options) {
    hash = crypto.createHash('sha1')
      .update(sql)
      .digest('hex');
  } else {
    hash = crypto.createHash('sha1')
      .update(sql + '-' + CircularJSON.stringify(desymbolize(options), jsonReplacer))
      .digest('hex');
  }
  return [this.cachePrefix, '__raw__', 'query', hash].join(':');
};

Cacher.prototype.key = function key(options, method, model, keys) {
  const hash = crypto.createHash('sha1')
    .update(CircularJSON.stringify(desymbolize(options), jsonReplacer))
    .digest('hex');
  if (!keys || keys.length === 0) return [this.cachePrefix, model, method, hash].join(':');
  return [this.cachePrefix, model, method, hash, keys.join(',')].join(':');
};

/**
 * Execute the query and return a promise
 */
Cacher.prototype.run = function run(options, keys) {
  return this.fetchFromCache(options, this.method, this.modelName, keys);
};

/**
 * Add a retrieval method
 */
function addMethod(key) {
  Cacher.prototype[key] = function() {
    if (!this.md) {
      return Promise.reject(new Error('Model not set'));
    }
    this.method = key;
    return this.run.apply(this, arguments);
  };
}

/**
 * Run given manual query
 */
Cacher.prototype.query = function query(sql, options) {
  return this.rawFromCache(sql, options);
};

/**
 * Fetch data from cache
 */
Cacher.prototype.fetchFromCache = function fetchFromCache(options, method, model, keyIds) {
  var self = this;
  return new Promise(function promiser(resolve, reject) {
    var key = self.key(options, method, model, keyIds);
    return self.redis.get(key, function(err, res) {
      if (err) {
        return reject(err);
      }
      if (!res) {
        return self.fetchFromDatabase(key, options, method, model).then(resolve, reject);
      }
      self.cacheHit = true;
      try {
        return resolve(JSON.parse(res));
      } catch (e) {
        return reject(e);
      }
    });
  });
};

/**
 * Fetch data from cache for raw type query
 */
Cacher.prototype.rawFromCache = function rawFromCache(sql, options) {
  var self = this;
  return new Promise(function promiser(resolve, reject) {
    var key = self.keySQL(sql, options);
    return self.redis.get(key, function(err, res) {
      if (err) {
        return reject(err);
      }
      if (!res) {
        return self.rawFromDatabase(key, sql, options).then(resolve, reject);
      }
      self.cacheHit = true;
      try {
        return resolve(JSON.parse(res));
      } catch (e) {
        return reject(e);
      }
    });
  });
};

/**
 * Set data in cache
 */
Cacher.prototype.setCache = function setCache(key, results, ttl) {
  var self = this;
  return new Promise(function promiser(resolve, reject) {
    var args = [];
    var res;
    try {
      res = JSON.stringify(results);
    } catch (e) {
      return reject(e);
    }

    args.push(key, res);
    if (ttl) {
      args.push('EX', ttl);
    }

    return self.redis.set(args, function(err, res) {
      if (err) {
        return reject(err);
      }
      return resolve(res);
    });
  });
};

/**
 * Fetch from the database
 */
Cacher.prototype.fetchFromDatabase = function fetchFromDatabase(key, options, methodName, model) {
  var self = this;
  var seqModel = this.sequelize.model(model);
  var method = seqModel[methodName];
  return new Promise(function promiser(resolve, reject) {
    if (!method) {
      return reject(new Error('Invalid method - ' + method));
    }
    return method.call(seqModel, options)
      .then(function then(results) {
        var res;
        if (!results) {
          res = results;
        } else if (Array.isArray(results)) {
          res = results;
        } else if (results.toString() === '[object SequelizeInstance]') {
          res = results.get({ plain: true });
        } else {
          res = results;
        }
        return self.setCache(key, res, self.seconds)
          .then(
            function good() {
              return resolve(res);
            },
            function bad(err) {
              return reject(err);
            }
          );
      },
      function(err) {
        reject(err);
      });
  });
};

/**
 * Fetch raw query from the database
 */
Cacher.prototype.rawFromDatabase = function rawFromDatabase(key, sql, options) {
  var self = this;
  return new Promise(function promiser(resolve, reject) {
    if (!options) options = { type: self.sequelize.QueryTypes.SELECT };
    return self.sequelize.query(sql, options)
      .then(function then(results) {
          var res;
          if (!results) {
            res = results;
          } else if (Array.isArray(results)) {
            res = results;
          } else if (results.toString() === '[object SequelizeInstance]') {
            res = results.get({ plain: true });
          } else {
            res = results;
          }
          return self.setCache(key, res, self.seconds)
            .then(
              function good() {
                return resolve(res);
              },
              function bad(err) {
                return reject(err);
              }
            );
        },
        function(err) {
          reject(err);
        });
  });
};

/**
 * Clear cache with given keys
 */
// Cacher.prototype.clearCacheFor = function clearCache(opts) {
//   var self = this;
//   this.options = opts || this.options;
//   return new Promise(function promiser(resolve, reject) {
//     var key = self.key();
//     return self.redis.del(key, function onDel(err) {
//       if (err) {
//         return reject(err);
//       }
//       return resolve();
//     });
//   });
// };

/**
 * Clear key with pattern
 */
Cacher.prototype.clearCacheForPattern = function clearCacheForPattern(pattern) {
  var finalPattern = `${this.cachePrefix}:*${pattern}*`;
  if (this.toBeDelKeys[hash]) {
    return null;
  }
  var hash = crypto.createHash('sha1')
      .update(finalPattern)
      .digest('hex');
  this.toBeDelKeys[hash] = [];
  return this.scanRedisForDelete(finalPattern, hash);
};

/**
 * scanning data
 */
Cacher.prototype.scanRedisForDelete = function scanRedis(pattern, hash, cursor) {
  var self = this;
  var startFrom = cursor || 0;
  self.redis.scan(startFrom, 'MATCH', pattern, 'COUNT', 100, function(err, reply) {
    if (err) {
      delete self.toBeDelKeys[hash];
    }
    self.toBeDelKeys[hash] = self.toBeDelKeys[hash].concat(reply[1]);
    if (reply[0] === '0') {
      self.deleteKey(hash);
    } else {
      self.scanRedisForDelete(pattern, hash, parseInt(reply[0], 10))
    }
  });
}

/**
 * delete by key
 */
Cacher.prototype.deleteKey = function deleteKey(hash) {
  if (this.toBeDelKeys[hash] && this.toBeDelKeys[hash].length > 0) {
    var delMe = this.toBeDelKeys[hash];
    for (const key in delMe) {
      this.redis.unlink(delMe[key]);
    }
    delete this.toBeDelKeys[hash];
  }
}

/**
 * Replace sequelize Op.*
 */
function desymbolize(o) {
  if (Array.isArray(o)) {
    return o.map(desymbolize);
  } else if (typeof o != "object" || o === undefined) {
    return o;
  } else if (o) {
    let d = Object.assign(Object.create(Object.getPrototypeOf(o)), o);
    Object.getOwnPropertySymbols(o).forEach(k => {
      d[`${Symbol.keyFor(k)}`] = o[k];
      delete d[k];
    });
    Object.keys(d).forEach(k => d[k] = desymbolize(d[k]));
    return d;
  }
}

/**
 * Duct tape to check if this is a sequelize DAOFactory
 */
function jsonReplacer(key, value) {
  if (value && (value.DAO || value.sequelize)) {
    return value.name || '';
  }
  return value;
}

var methods = [
  'find',
  'findOne',
  'findAll',
  'findAndCount',
  'findAndCountAll',
  'all',
  'min',
  'max',
  'sum',
  'count'
];

methods.forEach(addMethod);
