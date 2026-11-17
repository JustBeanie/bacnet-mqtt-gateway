process.env.NODE_ENV = 'development';

const { EventEmitter } = require('node:events');
const Bacstack = require('bacstack');
const apdu = require('bacstack/lib/apdu');
const bvlc = require('bacstack/lib/bvlc');
const npdu = require('bacstack/lib/npdu');
const { readProperty } = require('bacstack/lib/services');
const { BacnetRequests, BacnetUnavailableError } = require('../src/bacnet_requests');

const { ApplicationTags, ConfirmedServiceChoice, PropertyIdentifier, PduTypes, PduConReqBits, BvlcResultPurpose } = Bacstack.enum;
const objectId = { type: 8, instance: 1 };
const firstDevice = '192.0.2.1';
const secondDevice = '192.0.2.2';

class MemoryTransport extends EventEmitter {
    constructor() {
        super();
        this.sent = [];
    }

    getMaxPayload() { return 1482; }
    open() {}
    close() {}

    send(buffer, length) {
        const packet = Buffer.from(buffer.subarray(0, length));
        this.sent.push(packet);
        this.forward?.(packet);
    }
}

function requestDetails(packet) {
    const offset = bvlc.decode(packet, 0).len;
    const apduOffset = offset + npdu.decode(packet, offset).len;
    const request = apdu.decodeConfirmedServiceRequest(packet, apduOffset);
    request.property = readProperty.decode(packet, apduOffset + request.len, packet.length - apduOffset - request.len).property;
    return request;
}

function segmentedResponse(invokeId, value) {
    const payload = { buffer: Buffer.alloc(256), offset: 0 };
    readProperty.encodeAcknowledge(payload, objectId, PropertyIdentifier.OBJECT_LIST, 0, [
        { type: ApplicationTags.UNSIGNED_INTEGER, value }
    ]);
    const middle = Math.floor(payload.offset / 2);
    return [payload.buffer.subarray(0, middle), payload.buffer.subarray(middle, payload.offset)]
        .map((segment, sequence) => {
            const packet = { buffer: Buffer.alloc(256), offset: 4 };
            npdu.encode(packet, 0, firstDevice);
            const type = PduTypes.COMPLEX_ACK | PduConReqBits.SEGMENTED_MESSAGE
                | (sequence === 0 ? PduConReqBits.MORE_FOLLOWS : 0);
            apdu.encodeComplexAck(packet, type, ConfirmedServiceChoice.READ_PROPERTY, invokeId, sequence, 2);
            segment.copy(packet.buffer, packet.offset);
            packet.offset += segment.length;
            bvlc.encode(packet.buffer, BvlcResultPurpose.ORIGINAL_UNICAST_NPDU, packet.offset);
            return packet.buffer.subarray(0, packet.offset);
        });
}

describe('pinned BACnet transport', () => {
    test('gateway polling and writes use the real stack property and application tags', async () => {
        const { BacnetClient } = require('../src/bacnet_client');
        const gatewayTransport = new MemoryTransport();
        const deviceTransport = new MemoryTransport();
        const stack = new Bacstack({ transport: gatewayTransport });
        const device = new Bacstack({ transport: deviceTransport });
        gatewayTransport.forward = (packet) => deviceTransport.emit('message', packet, secondDevice);
        deviceTransport.forward = (packet) => gatewayTransport.emit('message', packet, firstDevice);
        const point = { type: 2, instance: 101 };
        const runtimeState = {
            init: jest.fn().mockResolvedValue(),
            upsertDeviceState: jest.fn().mockResolvedValue(),
            saveObjectTelemetry: jest.fn().mockResolvedValue(),
            recordPollHistory: jest.fn().mockResolvedValue()
        };
        const bacnetConfig = new EventEmitter();
        bacnetConfig.load = async () => {};
        const client = new BacnetClient({ client: stack, runtimeState, bacnetConfig });
        try {
            device.on('readPropertyMultiple', ({ address, invokeId }) => {
                device.readPropertyMultipleResponse(address, invokeId, [{
                    objectId: point,
                    values: [
                        { property: { id: PropertyIdentifier.PRESENT_VALUE, index: Bacstack.enum.ASN1_ARRAY_ALL },
                            value: [{ type: ApplicationTags.REAL, value: 21.5 }] },
                        { property: { id: PropertyIdentifier.OBJECT_NAME, index: Bacstack.enum.ASN1_ARRAY_ALL },
                            value: [{ type: ApplicationTags.CHARACTER_STRING, value: 'Temperature' }] },
                        { property: { id: PropertyIdentifier.UNITS, index: Bacstack.enum.ASN1_ARRAY_ALL },
                            value: [{ value: { type: 'BacnetError', errorClass: 2, errorCode: 32 } }] }
                    ]
                }]);
            });
            const onWrite = jest.fn(({ address, invokeId }) => {
                device.simpleAckResponse(address, ConfirmedServiceChoice.WRITE_PROPERTY, invokeId);
            });
            device.on('writeProperty', onWrite);

            await client.ready;
            await client.startPolling({ deviceId: 1, address: firstDevice }, [{ objectId: point }]);
            await client._pollDevice('1');
            expect(runtimeState.saveObjectTelemetry).toHaveBeenCalledWith(
                '1', '2_101', expect.objectContaining({ value: 21.5, name: 'Temperature', units: null })
            );
            expect(client.deviceRuntime.get('1').unsupportedUnits.has('2_101')).toBe(true);
            await client.writeProperty(firstDevice, point, PropertyIdentifier.PRESENT_VALUE, 17);
            expect(onWrite).toHaveBeenCalledWith(expect.objectContaining({
                request: expect.objectContaining({
                    objectId: point,
                    value: expect.objectContaining({
                        value: [expect.objectContaining({ type: ApplicationTags.SIGNED_INTEGER, value: 17 })]
                    })
                })
            }));
            await client.writeProperty(firstDevice, point, PropertyIdentifier.PRESENT_VALUE, 19, 8);
            expect(onWrite.mock.lastCall[0].request.value.priority).toBe(8);
        } finally {
            await Promise.all([client.close(), device.close()]);
        }
    });

    test('keeps interleaved segmented replies attached to the correct peer and invoke ID', async () => {
        const transport = new MemoryTransport();
        const client = new Bacstack({ transport });
        try {
            const first = jest.fn();
            const second = jest.fn();
            client.readProperty(firstDevice, objectId, PropertyIdentifier.OBJECT_LIST, { arrayIndex: 0 }, first);
            client.readProperty(secondDevice, objectId, PropertyIdentifier.OBJECT_LIST, { arrayIndex: 0 }, second);
            const [one, two] = transport.sent.map(requestDetails);
            expect(one.property.index).toBe(0);
            expect(two.invokeId).not.toBe(one.invokeId);
            const [firstStart, firstEnd] = segmentedResponse(one.invokeId, 11);
            const [secondStart, secondEnd] = segmentedResponse(two.invokeId, 22);
            transport.emit('message', firstStart, firstDevice);
            transport.emit('message', secondStart, secondDevice);
            transport.emit('message', firstEnd, secondDevice);
            expect(first).not.toHaveBeenCalled();
            transport.emit('message', secondEnd, secondDevice);
            transport.emit('message', firstEnd, firstDevice);

            expect(first).toHaveBeenCalledWith(null, expect.objectContaining({ values: [expect.objectContaining({ value: 11 })] }));
            expect(second).toHaveBeenCalledWith(null, expect.objectContaining({ values: [expect.objectContaining({ value: 22 })] }));
            expect(client._invokeStore.size).toBe(0);
            expect(client._segmentStore.size).toBe(0);
        } finally {
            await client.close();
        }
    });

    test('releases invoke IDs, partial replies, and transport listeners on timeout and repeated close', async () => {
        jest.useFakeTimers();
        const transport = new MemoryTransport();
        const client = new Bacstack({ transport, apduTimeout: 100 });
        try {
            const first = jest.fn();
            const second = jest.fn();
            client.readProperty(firstDevice, objectId, PropertyIdentifier.OBJECT_LIST, { arrayIndex: 0 }, first);
            const { invokeId } = requestDetails(transport.sent[0]);
            transport.emit('message', segmentedResponse(invokeId, 11)[0], firstDevice);
            client._invokeCounter = invokeId;
            client.readProperty(secondDevice, objectId, PropertyIdentifier.OBJECT_LIST, { arrayIndex: 0 }, second);
            expect(requestDetails(transport.sent.at(-1)).invokeId).not.toBe(invokeId);

            jest.advanceTimersByTime(100);
            expect(first).toHaveBeenCalledWith(expect.objectContaining({ message: 'ERR_TIMEOUT' }));
            expect(client._segmentStore.size).toBe(0);
            expect(client._invokeStore.size).toBe(0);

            const pending = jest.fn();
            client.readProperty(firstDevice, objectId, PropertyIdentifier.OBJECT_LIST, {}, pending);
            const closed = client.close();
            expect(client.close()).toBe(closed);
            await closed;
            expect(pending).toHaveBeenCalledWith(expect.objectContaining({ message: 'BACnet client is closed' }));
            expect(transport.eventNames()).toEqual([]);
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            await client.close();
            jest.useRealTimers();
        }
    });
});

describe('BACnet request queue', () => {
    test('caps work at 64 active and 256 waiting and rejects the remaining work on close', async () => {
        const queue = new BacnetRequests();
        const send = jest.fn();
        const jobs = Array.from({ length: 320 }, () => queue.submit(send));
        const settled = Promise.allSettled(jobs);
        expect(send).toHaveBeenCalledTimes(64);
        expect(queue.waiting).toHaveLength(256);
        await expect(queue.submit(send)).rejects.toBeInstanceOf(BacnetUnavailableError);

        queue.close();
        expect((await settled).every(({ status }) => status === 'rejected')).toBe(true);
        expect(queue.active.size).toBe(0);
        expect(queue.waiting).toHaveLength(0);
    });

    test('serializes writes to one point while independent requests continue', async () => {
        const queue = new BacnetRequests();
        let finish;
        const first = queue.submit((done) => { finish = done; }, 'device:point:property');
        const secondWrite = jest.fn((done) => done(null, 'second write'));
        const second = queue.submit(secondWrite, 'device:point:property');

        await expect(queue.submit((done) => done(null, 'independent'))).resolves.toBe('independent');
        expect(secondWrite).not.toHaveBeenCalled();
        finish(null, 'first write');
        await expect(first).resolves.toBe('first write');
        await expect(second).resolves.toBe('second write');
    });
});
