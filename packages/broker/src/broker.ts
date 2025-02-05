import { startNetworkNode, Protocol, MetricsContext } from 'streamr-network'
import StreamrClient from 'streamr-client'
import publicIp from 'public-ip'
import { Wallet } from 'ethers'
import { Logger } from 'streamr-network'
import { Server as HttpServer } from 'http'
import { Server as HttpsServer } from 'https'
import { Publisher } from './Publisher'
import { VolumeLogger } from './VolumeLogger'
import { SubscriptionManager } from './SubscriptionManager'
import { createPlugin } from './pluginRegistry'
import { validateConfig } from './helpers/validateConfig'
import { version as CURRENT_VERSION } from '../package.json'
import { Config, NetworkSmartContract, StorageNodeRegistryItem } from './config'
import { Plugin, PluginOptions } from './Plugin'
import { startServer as startHttpServer, stopServer } from './httpServer'
import BROKER_CONFIG_SCHEMA from './helpers/config.schema.json'
import { createLocalStreamrClient } from './localStreamrClient'
import { createApiAuthenticator } from './apiAuthenticator'
import { StorageNodeRegistry } from "./StorageNodeRegistry"
const { Utils } = Protocol

const logger = new Logger(module)

export interface Broker {
    getNeighbors: () => readonly string[]
    getStreams: () => readonly string[]
    close: () => Promise<unknown>
}

export const startBroker = async (config: Config): Promise<Broker> => {
    validateConfig(config, BROKER_CONFIG_SCHEMA)

    logger.info(`Starting broker version ${CURRENT_VERSION}`)

    const networkNodeName = config.network.name
    const metricsContext = new MetricsContext(networkNodeName)

    // Ethereum wallet retrieval
    const wallet = new Wallet(config.ethereumPrivateKey)
    if (!wallet) {
        throw new Error('Could not resolve Ethereum address from given config.ethereumPrivateKey')
    }
    const brokerAddress = wallet.address

    // Form tracker list
    let trackers: string[]
    if ((config.network.trackers as NetworkSmartContract).contractAddress) {
        const registry = await Protocol.Utils.getTrackerRegistryFromContract({
            contractAddress: (config.network.trackers as NetworkSmartContract).contractAddress,
            jsonRpcProvider: (config.network.trackers as NetworkSmartContract).jsonRpcProvider
        })
        trackers = registry.getAllTrackers().map((record) => record.ws)
    } else {
        trackers = config.network.trackers as string[]
    }

    // Form storage node list
    let storageNodes: StorageNodeRegistryItem[]
    if ((config.storageNodeConfig.registry as NetworkSmartContract).contractAddress) {
        const registry = await Protocol.Utils.getStorageNodeRegistryFromContract({
            contractAddress: (config.storageNodeConfig.registry as NetworkSmartContract).contractAddress,
            jsonRpcProvider: (config.storageNodeConfig.registry as NetworkSmartContract).jsonRpcProvider
        })
        storageNodes = registry.getAllStorageNodes()
    } else {
        storageNodes = config.storageNodeConfig.registry as StorageNodeRegistryItem[]
    }

    const storageNodeRegistry = StorageNodeRegistry.createInstance(config, storageNodes)

    // Start network node
    const advertisedWsUrl = config.network.advertisedWsUrl !== 'auto'
        ? config.network.advertisedWsUrl
        : await publicIp.v4().then((ip) => `ws://${ip}:${config.network.port}`)
    const networkNode = await startNetworkNode({
        host: config.network.hostname,
        port: config.network.port,
        id: brokerAddress,
        name: networkNodeName,
        trackers,
        advertisedWsUrl,
        location: config.network.location,
        metricsContext
    })
    networkNode.start()

    // Set up reporting to Streamr stream
    let client: StreamrClient | undefined
    let legacyStreamId: string | undefined

    if (config.reporting.streamr || (config.reporting.perNodeMetrics && config.reporting.perNodeMetrics.enabled)) {
        const targetStorageNode = config.reporting.perNodeMetrics!.storageNode
        const storageNodeRegistryItem = storageNodes.find((n) => n.address === targetStorageNode)
        if (storageNodeRegistryItem === undefined) {
            throw new Error(`Value ${storageNodeRegistryItem} (config.reporting.perNodeMetrics.storageNode) not ` +
                'present in config.storageNodeRegistry')
        }
        client = new StreamrClient({
            auth: {
                privateKey: config.ethereumPrivateKey,
            },
            url: config.reporting.perNodeMetrics ? (config.reporting.perNodeMetrics.wsUrl || undefined) : undefined,
            restUrl: config.reporting.perNodeMetrics ? (config.reporting.perNodeMetrics.httpUrl || undefined) : undefined,
            storageNode: storageNodeRegistryItem
        })

        if (config.reporting.streamr && config.reporting.streamr.streamId) {
            const { streamId } = config.reporting.streamr
            legacyStreamId = streamId
            logger.info(`Starting StreamrClient reporting with streamId: ${streamId}`)
        } else {
            logger.info('StreamrClient reporting disabled')
        }
    } else {
        logger.info('StreamrClient and perNodeMetrics disabled')
    }

    // Validator only needs public information, so use unauthenticated client for that
    const unauthenticatedClient = new StreamrClient({
        restUrl: config.streamrUrl + '/api/v1',
    })
    const streamMessageValidator = new Utils.CachingStreamMessageValidator({
        getStream: (sId) => unauthenticatedClient.getStreamValidationInfo(sId),
        isPublisher: (address, sId) => unauthenticatedClient.isStreamPublisher(sId, address),
        isSubscriber: (address, sId) => unauthenticatedClient.isStreamSubscriber(sId, address),
    })
    const publisher = new Publisher(networkNode, streamMessageValidator, metricsContext)
    const subscriptionManager = new SubscriptionManager(networkNode)
    const localStreamrClient = createLocalStreamrClient(config)
    const apiAuthenticator = createApiAuthenticator(config)

    const plugins: Plugin<any>[] = Object.keys(config.plugins).map((name) => {
        const pluginOptions: PluginOptions = {
            name,
            networkNode,
            subscriptionManager,
            publisher,
            streamrClient: localStreamrClient,
            apiAuthenticator,
            metricsContext,
            brokerConfig: config,
            storageNodeRegistry
        }
        return createPlugin(name, pluginOptions)
    })

    await Promise.all(plugins.map((plugin) => plugin.start()))
    const httpServerRoutes = plugins.flatMap((plugin) => plugin.getHttpServerRoutes())
    let httpServer: HttpServer|HttpsServer|undefined
    if (httpServerRoutes.length > 0) {
        if (config.httpServer === null) {
            throw new Error('HTTP server config not defined')
        }
        httpServer = await startHttpServer(httpServerRoutes, config.httpServer, apiAuthenticator)
    }

    let reportingIntervals
    let storageNodeAddress

    if (config.reporting && config.reporting.perNodeMetrics && config.reporting.perNodeMetrics.intervals) {
        reportingIntervals = config.reporting.perNodeMetrics.intervals
        storageNodeAddress = config.reporting.perNodeMetrics.storageNode
    }

    // Start logging facilities
    const volumeLogger = new VolumeLogger(
        config.reporting.intervalInSeconds,
        metricsContext,
        client,
        legacyStreamId,
        brokerAddress,
        reportingIntervals,
        storageNodeAddress
    )
    await volumeLogger.start()

    logger.info(`Network node '${networkNodeName}' running on ${config.network.hostname}:${config.network.port}`)
    logger.info(`Ethereum address ${brokerAddress}`)
    logger.info(`Configured with trackers: ${trackers.join(', ')}`)
    logger.info(`Configured with Streamr: ${config.streamrUrl}`)
    logger.info(`Plugins: ${JSON.stringify(plugins.map((p) => p.name))}`)
    if (advertisedWsUrl) {
        logger.info(`Advertising to tracker WS url: ${advertisedWsUrl}`)
    }

    return {
        getNeighbors: () => networkNode.getNeighbors(),
        getStreams: () => networkNode.getStreams(),
        close: async () => {
            if (httpServer !== undefined) {
                await stopServer(httpServer)
            }
            await Promise.all(plugins.map((plugin) => plugin.stop()))
            if (localStreamrClient !== undefined) {
                await localStreamrClient.ensureDisconnected()
            }        
            await Promise.all([networkNode.stop(), volumeLogger.close()])
        }
    }
}

process.on('uncaughtException', (err) => {
    logger.getFinalLogger().error(err, 'uncaughtException')
    process.exit(1)
})

process.on('unhandledRejection', (err) => {
    logger.getFinalLogger().error(err, 'unhandledRejection')
    process.exit(1)
})
