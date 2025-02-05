import crypto from 'crypto'
import { O } from 'ts-toolbelt'
import { promisify } from 'util'

// this is shimmed out for actual browser build allows us to run tests in node against browser API
import { Crypto } from 'node-webcrypto-ossl'
import { arrayify, hexlify } from '@ethersproject/bytes'
import { MessageLayer } from 'streamr-client-protocol'

import { uuid } from '../../utils'
import { inspect } from '../../utils/log'

const { StreamMessage, EncryptedGroupKey } = MessageLayer

export class StreamMessageProcessingError extends Error {
    streamMessage: MessageLayer.StreamMessage
    constructor(message = '', streamMessage: MessageLayer.StreamMessage) {
        super(`Could not process. ${message} ${inspect(streamMessage)}`)
        this.streamMessage = streamMessage
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor)
        }
    }
}

export class UnableToDecryptError extends StreamMessageProcessingError {
    constructor(message = '', streamMessage: MessageLayer.StreamMessage) {
        super(`Unable to decrypt. ${message} ${inspect(streamMessage)}`, streamMessage)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor)
        }
    }
}

class InvalidGroupKeyError extends Error {
    groupKey: GroupKey | any
    constructor(message: string, groupKey?: any) {
        super(message)
        this.groupKey = groupKey
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor)
        }
    }
}

type GroupKeyObject = {
    id: string,
    hex: string,
    data: Uint8Array,
}

type GroupKeyProps = {
    groupKeyId: string,
    groupKeyHex: string,
    groupKeyData: Uint8Array,
}

function GroupKeyObjectFromProps(data: GroupKeyProps | GroupKeyObject) {
    if ('groupKeyId' in data) {
        return {
            id: data.groupKeyId,
            hex: data.groupKeyHex,
            data: data.groupKeyData,
        }
    }

    return data
}

interface GroupKey extends GroupKeyObject {}

export type GroupKeyish = GroupKey | GroupKeyObject | ConstructorParameters<typeof GroupKey>

// eslint-disable-next-line no-redeclare
class GroupKey {
    static InvalidGroupKeyError = InvalidGroupKeyError

    static validate(maybeGroupKey: GroupKey) {
        if (!maybeGroupKey) {
            throw new InvalidGroupKeyError(`value must be a ${this.name}: ${inspect(maybeGroupKey)}`, maybeGroupKey)
        }

        if (!(maybeGroupKey instanceof this)) {
            throw new InvalidGroupKeyError(`value must be a ${this.name}: ${inspect(maybeGroupKey)}`, maybeGroupKey)
        }

        if (!maybeGroupKey.id || typeof maybeGroupKey.id !== 'string') {
            throw new InvalidGroupKeyError(`${this.name} id must be a string: ${inspect(maybeGroupKey)}`, maybeGroupKey)
        }

        if (maybeGroupKey.id.includes('---BEGIN')) {
            throw new InvalidGroupKeyError(
                `${this.name} public/private key is not a valid group key id: ${inspect(maybeGroupKey)}`,
                maybeGroupKey
            )
        }

        if (!maybeGroupKey.data || !Buffer.isBuffer(maybeGroupKey.data)) {
            throw new InvalidGroupKeyError(`${this.name} data must be a Buffer: ${inspect(maybeGroupKey)}`, maybeGroupKey)
        }

        if (!maybeGroupKey.hex || typeof maybeGroupKey.hex !== 'string') {
            throw new InvalidGroupKeyError(`${this.name} hex must be a string: ${inspect(maybeGroupKey)}`, maybeGroupKey)
        }

        if (maybeGroupKey.data.length !== 32) {
            throw new InvalidGroupKeyError(`Group key must have a size of 256 bits, not ${maybeGroupKey.data.length * 8}`, maybeGroupKey)
        }

    }

    id: string
    hex: string
    data: Uint8Array

    constructor(groupKeyId: string, groupKeyBufferOrHexString: Uint8Array | string) {
        this.id = groupKeyId
        if (!groupKeyId) {
            throw new InvalidGroupKeyError(`groupKeyId must not be falsey ${inspect(groupKeyId)}`)
        }

        if (!groupKeyBufferOrHexString) {
            throw new InvalidGroupKeyError(`groupKeyBufferOrHexString must not be falsey ${inspect(groupKeyBufferOrHexString)}`)
        }

        if (typeof groupKeyBufferOrHexString === 'string') {
            this.hex = groupKeyBufferOrHexString
            this.data = Buffer.from(this.hex, 'hex')
        } else {
            this.data = groupKeyBufferOrHexString
            this.hex = Buffer.from(this.data).toString('hex')
        }

        // eslint-disable-next-line no-extra-semi
        ;(this.constructor as typeof GroupKey).validate(this)
    }

    equals(other: GroupKey) {
        if (!(other instanceof GroupKey)) {
            return false
        }

        return this === other || (this.hex === other.hex && this.id === other.id)
    }

    toString() {
        return this.id
    }

    toArray() {
        return [this.id, this.hex]
    }

    serialize() {
        return JSON.stringify(this.toArray())
    }

    static generate(id = uuid('GroupKey')) {
        const keyBytes = crypto.randomBytes(32)
        return new GroupKey(id, keyBytes)
    }

    static from(maybeGroupKey: GroupKeyish) {
        if (!maybeGroupKey || typeof maybeGroupKey !== 'object') {
            throw new InvalidGroupKeyError(`Group key must be object ${inspect(maybeGroupKey)}`)
        }

        if (maybeGroupKey instanceof GroupKey) {
            return maybeGroupKey
        }

        try {
            if (Array.isArray(maybeGroupKey)) {
                return new GroupKey(maybeGroupKey[0], maybeGroupKey[1])
            }

            const groupKeyObj = GroupKeyObjectFromProps(maybeGroupKey)
            return new GroupKey(groupKeyObj.id, groupKeyObj.hex || groupKeyObj.data)
        } catch (err) {
            if (err instanceof InvalidGroupKeyError) {
                // wrap err with logging of original object
                throw new InvalidGroupKeyError(`${err.stack}. From: ${inspect(maybeGroupKey)}`)
            }
            throw err
        }
    }
}

export { GroupKey }

function ab2str(...args: any[]) {
    // @ts-ignore
    return String.fromCharCode.apply(null, new Uint8Array(...args))
}

// shim browser btoa for node
function btoa(str: string | Uint8Array) {
    if (global.btoa) { return global.btoa(str as string) }
    let buffer

    if (Buffer.isBuffer(str)) {
        buffer = str
    } else {
        buffer = Buffer.from(str.toString(), 'binary')
    }

    return buffer.toString('base64')
}

async function exportCryptoKey(key: CryptoKey, { isPrivate = false } = {}) {
    const WebCrypto = new Crypto()
    const keyType = isPrivate ? 'pkcs8' : 'spki'
    const exported = await WebCrypto.subtle.exportKey(keyType, key)
    const exportedAsString = ab2str(exported)
    const exportedAsBase64 = btoa(exportedAsString)
    const TYPE = isPrivate ? 'PRIVATE' : 'PUBLIC'
    return `-----BEGIN ${TYPE} KEY-----\n${exportedAsBase64}\n-----END ${TYPE} KEY-----\n`
}

// put all static functions into EncryptionUtilBase, with exception of create,
// so it's clearer what the static & instance APIs look like
class EncryptionUtilBase {
    static validatePublicKey(publicKey: crypto.KeyLike) {
        const keyString = typeof publicKey === 'string' ? publicKey : publicKey.toString('utf8')
        if (typeof keyString !== 'string' || !keyString.startsWith('-----BEGIN PUBLIC KEY-----')
            || !keyString.endsWith('-----END PUBLIC KEY-----\n')) {
            throw new Error('"publicKey" must be a PKCS#8 RSA public key in the PEM format')
        }
    }

    static validatePrivateKey(privateKey: crypto.KeyLike) {
        const keyString = typeof privateKey === 'string' ? privateKey : privateKey.toString('utf8')
        if (typeof keyString !== 'string' || !keyString.startsWith('-----BEGIN PRIVATE KEY-----')
            || !keyString.endsWith('-----END PRIVATE KEY-----\n')) {
            throw new Error('"privateKey" must be a PKCS#8 RSA public key in the PEM format')
        }
    }

    /**
     * Returns a Buffer or a hex String
     */
    /* eslint-disable no-dupe-class-members */
    static encryptWithPublicKey(plaintextBuffer: Uint8Array, publicKey: crypto.KeyLike, outputInHex: true): string
    // These overrides tell ts outputInHex returns string
    static encryptWithPublicKey(plaintextBuffer: Uint8Array, publicKey: crypto.KeyLike): string
    static encryptWithPublicKey(plaintextBuffer: Uint8Array, publicKey: crypto.KeyLike, outputInHex: false): Buffer
    static encryptWithPublicKey(plaintextBuffer: Uint8Array, publicKey: crypto.KeyLike, outputInHex: boolean = false) {
        this.validatePublicKey(publicKey)
        const ciphertextBuffer = crypto.publicEncrypt(publicKey, plaintextBuffer)
        if (outputInHex) {
            return hexlify(ciphertextBuffer).slice(2)
        }
        return ciphertextBuffer
    }
    /* eslint-disable no-dupe-class-members */

    /*
     * Both 'data' and 'groupKey' must be Buffers. Returns a hex string without the '0x' prefix.
     */
    static encrypt(data: Uint8Array, groupKey: GroupKey): string {
        GroupKey.validate(groupKey)
        const iv = crypto.randomBytes(16) // always need a fresh IV when using CTR mode
        const cipher = crypto.createCipheriv('aes-256-ctr', groupKey.data, iv)

        return hexlify(iv).slice(2) + cipher.update(data, undefined, 'hex') + cipher.final('hex')
    }

    /*
     * 'ciphertext' must be a hex string (without '0x' prefix), 'groupKey' must be a GroupKey. Returns a Buffer.
     */
    static decrypt(ciphertext: string, groupKey: GroupKey) {
        GroupKey.validate(groupKey)
        const iv = arrayify(`0x${ciphertext.slice(0, 32)}`)
        const decipher = crypto.createDecipheriv('aes-256-ctr', groupKey.data, iv)
        return Buffer.concat([decipher.update(ciphertext.slice(32), 'hex'), decipher.final()])
    }

    /*
     * Sets the content of 'streamMessage' with the encryption result of the old content with 'groupKey'.
     */

    static encryptStreamMessage(streamMessage: MessageLayer.StreamMessage, groupKey: GroupKey, nextGroupKey?: GroupKey) {
        GroupKey.validate(groupKey)
        /* eslint-disable no-param-reassign */
        streamMessage.encryptionType = StreamMessage.ENCRYPTION_TYPES.AES
        streamMessage.groupKeyId = groupKey.id

        if (nextGroupKey) {
            GroupKey.validate(nextGroupKey)
            // @ts-expect-error
            streamMessage.newGroupKey = nextGroupKey
        }

        streamMessage.serializedContent = this.encrypt(Buffer.from(streamMessage.getSerializedContent(), 'utf8'), groupKey)
        if (nextGroupKey) {
            GroupKey.validate(nextGroupKey)
            streamMessage.newGroupKey = new EncryptedGroupKey(nextGroupKey.id, this.encrypt(nextGroupKey.data, groupKey))
        }
        streamMessage.parsedContent = undefined
        /* eslint-enable no-param-reassign */
    }

    /*
     * Decrypts the serialized content of 'streamMessage' with 'groupKey'. If the resulting plaintext is the concatenation
     * of a new group key and a message content, sets the content of 'streamMessage' with that message content and returns
     * the key. If the resulting plaintext is only a message content, sets the content of 'streamMessage' with that
     * message content and returns null.
     */

    static decryptStreamMessage(streamMessage: MessageLayer.StreamMessage, groupKey: GroupKey) {
        if ((streamMessage.encryptionType !== StreamMessage.ENCRYPTION_TYPES.AES)) {
            return null
        }

        try {
            GroupKey.validate(groupKey)
        } catch (err) {
            throw new UnableToDecryptError(`${err.message}`, streamMessage)
        }

        /* eslint-disable no-param-reassign */
        try {
            streamMessage.encryptionType = StreamMessage.ENCRYPTION_TYPES.NONE
            const serializedContent = this.decrypt(streamMessage.getSerializedContent(), groupKey).toString()
            streamMessage.parsedContent = JSON.parse(serializedContent)
            streamMessage.serializedContent = serializedContent
        } catch (err) {
            streamMessage.encryptionType = StreamMessage.ENCRYPTION_TYPES.AES
            throw new UnableToDecryptError(err.stack, streamMessage)
        }

        try {
            const { newGroupKey } = streamMessage
            if (newGroupKey) {
                // newGroupKey should be EncryptedGroupKey | GroupKey, but GroupKey is not defined in protocol
                // @ts-expect-error
                streamMessage.newGroupKey = GroupKey.from([
                    newGroupKey.groupKeyId,
                    this.decrypt(newGroupKey.encryptedGroupKeyHex, groupKey)
                ])
            }
        } catch (err) {
            streamMessage.encryptionType = StreamMessage.ENCRYPTION_TYPES.AES
            throw new UnableToDecryptError('Could not decrypt new group key: ' + err.stack, streamMessage)
        }
        return null
        /* eslint-enable no-param-reassign */
    }
}

// after EncryptionUtil is ready
type InitializedEncryptionUtil = O.Overwrite<EncryptionUtil, {
    privateKey: string,
    publicKey: string,
}>

/** @internal */
export default class EncryptionUtil extends EncryptionUtilBase {
    /**
     * Creates a new instance + waits for ready.
     * Convenience.
     */

    static async create(...args: ConstructorParameters<typeof EncryptionUtil>) {
        const encryptionUtil = new EncryptionUtil(...args)
        await encryptionUtil.onReady()
        return encryptionUtil
    }

    privateKey
    publicKey
    private _generateKeyPairPromise: Promise<void> | undefined

    constructor(options: {
        privateKey: string,
        publicKey: string,
    } | {} = {}) {
        super()
        if ('privateKey' in options && 'publicKey' in options) {
            EncryptionUtil.validatePrivateKey(options.privateKey)
            EncryptionUtil.validatePublicKey(options.publicKey)
            this.privateKey = options.privateKey
            this.publicKey = options.publicKey
        }
    }

    async onReady() {
        if (this.isReady()) { return undefined }
        return this._generateKeyPair()
    }

    isReady(this: EncryptionUtil): this is InitializedEncryptionUtil {
        return !!(this.privateKey && this.publicKey)
    }

    // Returns a Buffer
    decryptWithPrivateKey(ciphertext: string | Uint8Array, isHexString = false) {
        if (!this.isReady()) { throw new Error('EncryptionUtil not ready.') }
        const ciphertextBuffer = isHexString ? arrayify(`0x${ciphertext}`) : ciphertext as Uint8Array
        return crypto.privateDecrypt(this.privateKey, ciphertextBuffer)
    }

    // Returns a String (base64 encoding)
    getPublicKey() {
        if (!this.isReady()) { throw new Error('EncryptionUtil not ready.') }
        return this.publicKey
    }

    async _generateKeyPair() {
        if (!this._generateKeyPairPromise) {
            this._generateKeyPairPromise = this.__generateKeyPair()
        }
        return this._generateKeyPairPromise
    }

    async __generateKeyPair() {
        if (typeof window !== 'undefined') { return this._keyPairBrowser() }
        return this._keyPairServer()
    }

    async _keyPairServer() {
        // promisify here to work around browser/server packaging
        const generateKeyPair = promisify(crypto.generateKeyPair)
        const { publicKey, privateKey } = await generateKeyPair('rsa', {
            modulusLength: 4096,
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem',
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem',
            },
        })

        this.privateKey = privateKey
        this.publicKey = publicKey
    }

    async _keyPairBrowser() {
        const WebCrypto = new Crypto()
        const { publicKey, privateKey } = await WebCrypto.subtle.generateKey({
            name: 'RSA-OAEP',
            modulusLength: 4096,
            publicExponent: new Uint8Array([1, 0, 1]), // 65537
            hash: 'SHA-256'
        }, true, ['encrypt', 'decrypt'])

        const [exportedPrivate, exportedPublic] = await Promise.all([
            exportCryptoKey(privateKey, {
                isPrivate: true,
            }),
            exportCryptoKey(publicKey, {
                isPrivate: false,
            })
        ])
        this.privateKey = exportedPrivate
        this.publicKey = exportedPublic
    }
}
