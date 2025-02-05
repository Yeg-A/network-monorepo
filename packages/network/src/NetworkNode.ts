import { Node, Event as NodeEvent, NodeOptions } from './logic/Node'
import { StreamIdAndPartition } from './identifiers'
import { MessageLayer } from 'streamr-client-protocol'

/*
Convenience wrapper for building client-facing functionality. Used by broker.
 */
export class NetworkNode extends Node {
    constructor(opts: NodeOptions) {
        const networkOpts = {
            ...opts
        }
        super(networkOpts)
    }

    publish(streamMessage: MessageLayer.StreamMessage): void {
        this.onDataReceived(streamMessage)
    }

    addMessageListener(cb: (msg: MessageLayer.StreamMessage) => void): void {
        this.on(NodeEvent.UNSEEN_MESSAGE_RECEIVED, cb)
    }

    removeMessageListener(cb: (msg: MessageLayer.StreamMessage) => void): void {
        this.off(NodeEvent.UNSEEN_MESSAGE_RECEIVED, cb)
    }

    subscribe(streamId: string, streamPartition: number): void {
        this.subscribeToStreamIfHaveNotYet(new StreamIdAndPartition(streamId, streamPartition))
    }

    unsubscribe(streamId: string, streamPartition: number): void {
        this.unsubscribeFromStream(new StreamIdAndPartition(streamId, streamPartition))
    }
}
