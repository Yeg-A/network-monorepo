#!/usr/bin/env node
const program = require('commander')
const pino = require('pino')

const getLogger = require('../dist/helpers/logger').default
const { version: CURRENT_VERSION } = require('../package.json')
const { startTracker } = require('../dist/composition')
const { MetricsContext } = require('../dist/helpers/MetricsContext')

const logger = getLogger('streamr:bin:tracker')

program
    .version(CURRENT_VERSION)
    .option('--id <id>', 'Ethereum address / tracker id', undefined)
    .option('--trackerName <trackerName>', 'Human readable name', undefined)
    .option('--port <port>', 'port', '27777')
    .option('--ip <ip>', 'ip', '0.0.0.0')
    .option('--maxNeighborsPerNode <maxNeighborsPerNode>', 'maxNeighborsPerNode', '4')
    .option('--metrics <metrics>', 'output metrics to console', false)
    .option('--metricsInterval <metricsInterval>', 'metrics output interval (ms)', '5000')
    .description('Run tracker with reporting')
    .parse(process.argv)

const id = program.id || `tracker-${program.port}`
const name = program.trackerName || id

async function main() {
    const metricsContext = new MetricsContext(id)
    try {
        const tracker = await startTracker({
            host: program.ip,
            port: Number.parseInt(program.port, 10),
            id,
            name,
            maxNeighborsPerNode: Number.parseInt(program.maxNeighborsPerNode, 10),
            metricsContext
        })

        const trackerObj = {}
        const fields = ['ip', 'port', 'maxNeighborsPerNode', 'metrics', 'metricsInterval']
        fields.forEach((prop) => {
            trackerObj[prop] = program[prop]
        })

        logger.info('started tracker: %o', {
            id,
            name,
            ...trackerObj
        })

        if (program.metrics) {
            setInterval(async () => {
                const metrics = await metricsContext.report(true)
                // output to console
                if (program.metrics) {
                    logger.info(JSON.stringify(metrics, null, 4))
                }
            }, program.metricsInterval)
        }
    } catch (err) {
        pino.final(logger).error(err, 'tracker bin catch')
        process.exit(1)
    }
}

main()

// pino.finalLogger
process.on('uncaughtException', pino.final(logger, (err, finalLogger) => {
    finalLogger.error(err, 'uncaughtException')
    process.exit(1)
}))

process.on('unhandledRejection', pino.final(logger, (err, finalLogger) => {
    finalLogger.error(err, 'unhandledRejection')
    process.exit(1)
}))
