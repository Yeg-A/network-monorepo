import WebSocket from 'ws'
import { StreamrClient } from 'streamr-client'
import { Logger } from 'streamr-network'
import { ParsedQs } from 'qs'
import { parsePositiveInteger, parseQueryParameter } from '../../helpers/parser'
import { Connection } from './Connection'
import { closeWithError } from '../../helpers/closeWebsocket'

const logger = new Logger(module)

const parsePayloadJson = (contentAsString: string) => {
    try {
        return JSON.parse(contentAsString)
    } catch (e) {
        throw new Error(`Payload is not a JSON string: ${e.message}`)
    }
}

export class PublishConnection implements Connection {

    streamId: string
    partition?: number
    partitionKey?: string
    partitionKeyField?: string

    constructor(streamId: string, queryParams: ParsedQs) {
        this.streamId = streamId
        this.partition = parseQueryParameter<number>('partition', queryParams, parsePositiveInteger)
        this.partitionKey = queryParams['partitionKey'] as string|undefined
        this.partitionKeyField = queryParams['partitionKeyField'] as string|undefined
        const partitionDefinitions = [this.partition, this.partitionKey, this.partitionKeyField].filter((d) => d !== undefined)
        if (partitionDefinitions.length > 1) {
            throw new Error('Invalid combination of "partition", "partitionKey" and "partitionKeyField"')
        }
    }
    
    init(ws: WebSocket, streamrClient: StreamrClient) {
        ws.on('message', (contentPayload: string) => {
            try {
                const content = parsePayloadJson(contentPayload)
                const partitionKey = this.partitionKey ?? (this.partitionKeyField ? content[this.partitionKeyField] : undefined)
                streamrClient.publish({
                    id: this.streamId,
                    partition: this.partition
                }, content, undefined, partitionKey)
            } catch (err: any) {
                closeWithError(err, 'Unable to publish', ws, logger)
            }
        })
    }
}