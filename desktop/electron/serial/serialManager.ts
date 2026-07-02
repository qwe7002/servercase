import { SerialPort } from 'serialport';
import type {
  BleSerialDeviceInfo,
  SerialConnectionEvent,
  SerialOpenOptions,
  SerialTransport,
  WiredSerialPortInfo,
} from '../shared.js';
import type {
  Characteristic,
  Peripheral,
} from '@abandonware/noble';

type Noble = typeof import('@abandonware/noble');

interface WiredSession {
  transport: 'wired';
  port: SerialPort;
}

interface BleSession {
  transport: 'ble';
  peripheral: Peripheral;
  writeChar: Characteristic;
  notifyChar: Characteristic;
  onData: (data: Buffer, isNotification: boolean) => void;
  onDisconnect: (error: string) => void;
}

type SerialSession = WiredSession | BleSession;

const NORDIC_UART_SERVICE = '6e400001b5a3f393e0a9e50e24dcca9e';
const NORDIC_UART_WRITE = '6e400002b5a3f393e0a9e50e24dcca9e';
const NORDIC_UART_NOTIFY = '6e400003b5a3f393e0a9e50e24dcca9e';

export class SerialManager {
  private sessions = new Map<string, SerialSession>();
  private noblePromise: Promise<Noble> | null = null;

  constructor(
    private readonly onData: (sessionId: string, data: string) => void,
    private readonly onEvent: (event: SerialConnectionEvent) => void,
  ) {}

  async listPorts(): Promise<WiredSerialPortInfo[]> {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      pnpId: p.pnpId,
      locationId: p.locationId,
      productId: p.productId,
      vendorId: p.vendorId,
    }));
  }

  async scanBle(timeoutMs = 6000): Promise<BleSerialDeviceInfo[]> {
    const noble = await this.loadNoble();
    await this.waitForPoweredOn(noble);
    const discovered = new Map<string, BleSerialDeviceInfo>();

    const onDiscover = (peripheral: Peripheral) => {
      const name =
        peripheral.advertisement.localName ||
        peripheral.address ||
        peripheral.id;
      discovered.set(peripheral.id, {
        id: peripheral.id,
        name,
        address: peripheral.address,
        rssi: peripheral.rssi,
        serviceUuids: peripheral.advertisement.serviceUuids ?? [],
      });
    };

    noble.on('discover', onDiscover);
    try {
      await noble.startScanningAsync([], true);
      await delay(timeoutMs);
    } finally {
      noble.removeListener('discover', onDiscover);
      await noble.stopScanningAsync().catch(() => undefined);
    }

    return [...discovered.values()].sort((a, b) => b.rssi - a.rssi);
  }

  async open(sessionId: string, options: SerialOpenOptions): Promise<void> {
    await this.close(sessionId);
    this.emit(sessionId, options.transport, 'opening');
    try {
      if (options.transport === 'wired') {
        await this.openWired(sessionId, options);
      } else {
        await this.openBle(sessionId, options);
      }
    } catch (error) {
      this.emit(sessionId, options.transport, 'error', (error as Error).message);
      throw error;
    }
  }

  async write(sessionId: string, data: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('serial session is not open');
    const bytes = Buffer.from(data, 'utf8');
    if (session.transport === 'wired') {
      await new Promise<void>((resolve, reject) => {
        session.port.write(bytes, (error) => {
          if (error) reject(error);
          else session.port.drain((drainError) => (drainError ? reject(drainError) : resolve()));
        });
      });
      return;
    }

    const chunkSize = Math.max(20, (session.peripheral.mtu ?? 23) - 3);
    const withoutResponse = session.writeChar.properties.includes('writeWithoutResponse');
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      await session.writeChar.writeAsync(bytes.subarray(offset, offset + chunkSize), withoutResponse);
    }
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);

    if (session.transport === 'wired') {
      if (session.port.isOpen) {
        await new Promise<void>((resolve) => session.port.close(() => resolve()));
      }
      this.emit(sessionId, 'wired', 'closed');
      return;
    }

    session.notifyChar.removeListener('data', session.onData);
    session.peripheral.removeListener('disconnect', session.onDisconnect);
    await session.notifyChar.unsubscribeAsync().catch(() => undefined);
    if (session.peripheral.state === 'connected') {
      await session.peripheral.disconnectAsync().catch(() => undefined);
    }
    this.emit(sessionId, 'ble', 'closed');
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  private async openWired(
    sessionId: string,
    options: Extract<SerialOpenOptions, { transport: 'wired' }>,
  ): Promise<void> {
    const port = new SerialPort({
      path: options.path,
      baudRate: options.baudRate,
      dataBits: options.dataBits ?? 8,
      stopBits: options.stopBits ?? 1,
      parity: options.parity ?? 'none',
      autoOpen: false,
    });

    port.on('data', (data: Buffer) => this.onData(sessionId, data.toString('utf8')));
    port.on('error', (error) => this.emit(sessionId, 'wired', 'error', error.message));
    port.on('close', () => {
      if (this.sessions.delete(sessionId)) this.emit(sessionId, 'wired', 'closed');
    });

    await new Promise<void>((resolve, reject) => {
      port.open((error) => (error ? reject(error) : resolve()));
    });
    this.sessions.set(sessionId, { transport: 'wired', port });
    this.emit(sessionId, 'wired', 'open');
  }

  private async openBle(
    sessionId: string,
    options: Extract<SerialOpenOptions, { transport: 'ble' }>,
  ): Promise<void> {
    const noble = await this.loadNoble();
    await this.waitForPoweredOn(noble);
    const peripheral = await this.findPeripheral(noble, options.peripheralId);
    const serviceUuid = normalizeUuid(options.serviceUuid || NORDIC_UART_SERVICE);
    const writeUuid = normalizeUuid(options.writeCharacteristicUuid || NORDIC_UART_WRITE);
    const notifyUuid = normalizeUuid(options.notifyCharacteristicUuid || NORDIC_UART_NOTIFY);

    await peripheral.connectAsync();
    const { characteristics } =
      await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [serviceUuid],
        [writeUuid, notifyUuid],
      );
    const writeChar = characteristics.find((c) => normalizeUuid(c.uuid) === writeUuid);
    const notifyChar = characteristics.find((c) => normalizeUuid(c.uuid) === notifyUuid);
    if (!writeChar || !notifyChar) {
      await peripheral.disconnectAsync().catch(() => undefined);
      throw new Error('BLE UART characteristics were not found');
    }

    const onData = (data: Buffer) => this.onData(sessionId, data.toString('utf8'));
    const onDisconnect = (error: string) => {
      if (this.sessions.delete(sessionId)) {
        this.emit(sessionId, 'ble', error ? 'error' : 'closed', error || undefined);
      }
    };
    notifyChar.on('data', onData);
    peripheral.on('disconnect', onDisconnect);
    await notifyChar.subscribeAsync();
    this.sessions.set(sessionId, {
      transport: 'ble',
      peripheral,
      writeChar,
      notifyChar,
      onData,
      onDisconnect,
    });
    this.emit(sessionId, 'ble', 'open');
  }

  private async findPeripheral(noble: Noble, peripheralId: string): Promise<Peripheral> {
    await noble.stopScanningAsync().catch(() => undefined);

    return new Promise<Peripheral>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('BLE device was not found'));
      }, 10000);

      const onDiscover = (peripheral: Peripheral) => {
        if (peripheral.id !== peripheralId && peripheral.uuid !== peripheralId) return;
        cleanup();
        resolve(peripheral);
      };

      const cleanup = () => {
        clearTimeout(timer);
        noble.removeListener('discover', onDiscover);
        void noble.stopScanningAsync().catch(() => undefined);
      };

      noble.on('discover', onDiscover);
      noble.startScanningAsync([], true).catch((error) => {
        cleanup();
        reject(error);
      });
    });
  }

  private async waitForPoweredOn(noble: Noble): Promise<void> {
    if (noble._state === 'poweredOn') return;
    if (['unsupported', 'unauthorized', 'poweredOff'].includes(noble._state)) {
      throw new Error(`Bluetooth is ${noble._state}`);
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Bluetooth is ${noble._state}`));
      }, 8000);
      const onState = (state: string) => {
        if (state === 'poweredOn') {
          cleanup();
          resolve();
        } else if (['unsupported', 'unauthorized', 'poweredOff'].includes(state)) {
          cleanup();
          reject(new Error(`Bluetooth is ${state}`));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        noble.removeListener('stateChange', onState);
      };
      noble.on('stateChange', onState);
    });
  }

  private async loadNoble(): Promise<Noble> {
    this.noblePromise ??= import('@abandonware/noble');
    return this.noblePromise;
  }

  private emit(
    sessionId: string,
    transport: SerialTransport,
    state: SerialConnectionEvent['state'],
    error?: string,
  ): void {
    this.onEvent({ sessionId, transport, state, error });
  }
}

function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
