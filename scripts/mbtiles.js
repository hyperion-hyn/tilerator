#!/usr/bin/nodejs

'use strict';

let yaml = require('js-yaml'),
    pathLib = require('path'),
    Promise = require('bluebird'),
    fs = Promise.promisifyAll(require("fs")),
    _ = require('underscore'),
    qidx = require('quadtile-index'),
    core = require('@kartotherian/core'),
    yargs = require('yargs'),
    checkType = require('@kartotherian/input-validator'),
    jplib = require('@kartotherian/jobprocessor'),
    JobProcessor = jplib.JobProcessor,
    tilerator = require('../routes/tilerator'),
    Queue = require('../lib/Queue'),
    common = require('../lib/common');

const MBTILES_SOURCE_ID = 'mbtiles-file';
let mbtiles_source = undefined;

let args = yargs
    .usage('Usage: $0 [options]')
    .options({
        config: {
            describe: 'YAML-formatted configuration file',
            type: 'string',
            nargs: 1,
            coerce: function(arg) {
                return loadYamlFile(arg).services[0].conf;
            }
        },
        source: {
            // default: 'sources.prod.yaml',
            describe: 'YAML-formatted sources file',
            type: 'string',
            nargs: 1,
            coerce: normalizePath
        },
        url: {
            describe: 'Source URL',
            type: 'string',
            nargs: 1,
            coerce: checkType.normalizeUrl
        },
        v: {
            describe: 'Additional variable in YAML form. Use -v.varname value',
            type: 'string',
            nargs: 1,
            coerce: yaml.safeLoad
        },
        p: {
            describe: 'Additional param in YAML form. Use -p.paramname value',
            type: 'string',
            nargs: 1
        },
        j: {
            describe: 'Use -j.jobparam value to enque a job into the que, or if dumptiles is set, to output list of tiles',
            type: 'string',
            nargs: 1
        },
        verbose: {
            default: false,
            describe: 'be verbose',
            type: 'boolean'
        },
    })
    .help('h')
    .alias('h', 'help')
    .argv;

if (args.p && (!_.isObject(args.p) || _.isEmpty(args.p))) {
    exit('-p must be used with the parameter name, e.g.   -p.paramname value');
}
if (args.v && (!_.isObject(args.v) || _.isEmpty(args.v))) {
    exit('-v must be used with variable name, e.g.   -v.varname value');
}
if (args.j && (!_.isObject(args.j) || _.isEmpty(args.j))) {
    exit('-j must be used with job parameter name, e.g.   -j.paramname value');
}

let app = {
    logger: {
        log: function (level, msg) {
            console.log(level, msg);
        }
    },
    metrics: {
        endTiming: function() {}
    },
    conf: args.config || {}
};

if (args.source) {
    app.conf.sources = args.source;
}
if (!_.isArray(app.conf.sources)) {
    app.conf.sources = [app.conf.sources];
}
if (app.conf.variables) {
    if (!_.isArray(app.conf.variables)) {
        app.conf.variables = [app.conf.variables];
    }
} else {
    app.conf.variables = [];
}
if (args.v) {
    app.conf.variables.push(args.v);
}
if (args.dumptiles) {
    if (!args.j || !_.isObject(args.j) || _.isArray(args.j)) {
        exit('A job must be specified using -j.<param> <value> parameters');
    }
    // We can reuse the same source, as we are guaranteed that it exists, and we won't execute this job
    if (!args.j.storageId) {
        args.j.storageId = args.j.generatorId;
    }
}

app.conf.sources.push({
    MBTILES_SOURCE_ID:{
        'uri':'mbtiles///d2d-script.mbtiles',
        'formats': ['pbf']
    }
})

args.j['storageId'] = MBTILES_SOURCE_ID


return tilerator.bootstrap(app).then(function() {
    let sources = new core.Sources();
    return sources.init(app.conf.variables, app.conf.sources);
}).then(function (sources) {
    core.setSources(sources);
    mbtiles_source = core.getSources().getSourceById(MBTILES_SOURCE_ID)
    mbtiles_source.startWriting(() => undefined);
    if (args.j) {
        let job = common.paramsToJob(args.j, sources);

        // Make sure not to start the kueui
        app.conf.daemonOnly = true;
        let queue = new Queue(app);

        return common.enqueJob(queue, job, args.j);
    }
}).catch(function(err) {
    console.log(err);
    console.log(err.stack);
    process.exit(-2);
}).then(function() {
    mbtiles_source.stopWriting();
    console.log('done');
    process.exit(0);
});


/**
 * Convert relative path to absolute, assuming current file is one
 * level below the project root
 * @param path
 * @returns {*}
 */
function normalizePath(path) {
    return pathLib.resolve(require.resolve('../package.json'), '..', path);
}

function loadYamlFile(arg) {
    let filename = normalizePath(arg);
    return yaml.safeLoad(fs.readFileSync(filename, 'utf8'), {filename: filename});
}

function exit(message) {
    console.error(message);
    yargs.showHelp();
    process.exit(-1);
}
