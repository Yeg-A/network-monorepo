import TrackerMessage from '../TrackerMessage'

import StatusMessage from './StatusMessage'

import { Serializer } from '../../../Serializer'

const VERSION = 2

export default class StatusMessageSerializerV2 extends Serializer<StatusMessage> {
    toArray(statusMessage: StatusMessage) {
        return [
            VERSION,
            TrackerMessage.TYPES.StatusMessage,
            statusMessage.requestId,
            statusMessage.status
        ]
    }

    fromArray(arr: any[]) {
        const [
            version,
            type, // eslint-disable-line @typescript-eslint/no-unused-vars
            requestId,
            status
        ] = arr

        return new StatusMessage({
            version, requestId, status
        })
    }
}

TrackerMessage.registerSerializer(VERSION, TrackerMessage.TYPES.StatusMessage, new StatusMessageSerializerV2())
