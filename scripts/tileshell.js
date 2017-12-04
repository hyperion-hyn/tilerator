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
    Job = jplib.Job,
    tilerator = require('../routes/tilerator'),
    Queue = require('../lib/Queue'),
    common = require('../lib/common');

const MBTILES_SOURCE_ID = 'mbtiles-file';

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
        dumptiles: {
            describe: 'output tile indexes to this file',
            type: 'string'
        },
        dumprawidx: {
            describe: 'forces file output to a single zoom, index only format',
            type: 'boolean',
            implies: 'dumptiles',
            check: qidx.isValidZoom
        },
        dumpoverride: {
            default: false,
            describe: 'override file output if exists',
            implies: 'dumptiles',
            type: 'boolean'
        },
        verbose: {
            default: false,
            describe: 'be verbose',
            type: 'boolean'
        },
        writeMbtiles: {
            describe: 'File that will be used as .mbtiles storage (overwrites j.storageId and enforces j.parts=1) \
                       Jobs will be processed synchronously.',
            type: 'string',
            nargs: 1,
            coerce: normalizePath
        }
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
if (args.writeMbtiles) {
    app.conf.sources.push({
        [MBTILES_SOURCE_ID]:{
            'uri':'mbtiles://' + args.writeMbtiles,
            'formats': ['pbf']
        }
    })
    args.j['storageId'] = MBTILES_SOURCE_ID
    args.j['parts'] = 1
}

let processSyncJob = function(j, sources){
    console.log('Processing job Z='+j.zoom, ' size='+j.size);
    let jp = new JobProcessor(sources, {data: j}, app.metrics);
    jp.initSources();
    jp.tileStore.startWriting(() => undefined);
    jp.initSources = (() => undefined); // Ugly hack so that sources are not reinitialized
    return new Promise(function(resolve, reject) {
        jp.runAsync()
            .then(()=>
                jp.tileStore.stopWriting(()=>{
                    console.log('Sync job done');
                    resolve();
            }))
            .catch(reject);
    });
};

return tilerator.bootstrap(app).then(function() {
    let sources = new core.Sources();
    return sources.init(app.conf.variables, app.conf.sources);
}).then(function (sources) {
    core.setSources(sources);
    if (args.j) {
        let job = common.paramsToJob(args.j, sources);

        if (args.writeMbtiles) {
            job = new Job(job);
            let jobs = job.expandJobs();
            console.log(jobs.length + ' jobs to run, writing to ' + args.writeMbtiles);
            return Promise.resolve(jobs).each(j => processSyncJob(j, sources));
        }

        if (args.dumptiles) {
            let jp = new JobProcessor(sources, {data: job}, app.metrics);

            let outputStream = fs.createWriteStream(args.dumptiles, {flags: args.dumpoverride ? 'w' : 'wx'});

            jp.initSources();
            let iterator = jp.createMainIterator();

            let opt = {iterator: iterator, outputStream: outputStream, zoom: job.zoom, rawidx: args.dumprawidx};
            return dumpTiles(opt).then(function () {
                return outputStream.endAsync();
            });
        }

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
    console.log('done');
    process.exit(0);
});


function dumpTiles(opt) {
    return opt.iterator().then(function (iterValue) {
        if (iterValue !== undefined) {
            let val;
            if (opt.rawidx) {
                val = iterValue.idx.toString();
            } else {
                let xy = qidx.indexToXY(iterValue.idx);
                val = opt.zoom + '/' + xy[0] + '/' + xy[1];
            }
            opt.outputStream.write(val);
            opt.outputStream.write('\n');
            return dumpTiles(opt);
        }
    });
}


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
