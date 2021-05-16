import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { CarrierInfinityHomebridgePlatform } from './platform';

import { InfinityEvolutionSystemStatus, InfinityEvolutionSystemConfig, SYSTEM_MODE } from './infinityApi';

export class InfinityEvolutionPlatformAccessory {
  private service: Service;
  private system_status: InfinityEvolutionSystemStatus;
  private system_config: InfinityEvolutionSystemConfig;

  constructor(
    private readonly platform: CarrierInfinityHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Default-Manufacturer') // TODO
      .setCharacteristic(this.platform.Characteristic.Model, 'Default-Model') // TODO
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.serialNumber);

    this.service = this.accessory.getService(
      this.platform.Service.Thermostat) || this.accessory.addService(this.platform.Service.Thermostat,
    );
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.displayName);

    // Create accessory api bridge
    this.system_status = new InfinityEvolutionSystemStatus(
      this.platform.InfinityEvolutionApi,
      this.accessory.context.serialNumber,
    );
    this.system_status.fetch().then();
    this.system_config = new InfinityEvolutionSystemConfig(
      this.platform.InfinityEvolutionApi,
      this.accessory.context.serialNumber,
    );
    this.system_config.fetch().then();
        
    // create handlers
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this));
    
    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this));
    
    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(async () => {
        return await this.handleTempGet(await this.system_status.getZoneTemp());
      });
    
    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(async () => {
        const cmode = await this.system_config.getMode();
        switch (cmode) {
          case SYSTEM_MODE.COOL:
            return await this.handleTempGet(await this.system_status.getZoneCoolSetpoint());
          case SYSTEM_MODE.HEAT:
            return await this.handleTempGet(await this.system_status.getZoneHeatSetpoint());
          default:
            return await this.handleTempGet(
              (await this.system_status.getZoneCoolSetpoint() + await this.system_status.getZoneHeatSetpoint())
              / 2,
            );
        }
      })
      .onSet(async (value) => {
        return await this.handleTempSet(value, 'target_temp');
      });
    
    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .onGet(async () => {
        return await this.handleTempGet(await this.system_status.getZoneCoolSetpoint());
      })
      .onSet(async (value) => {
        return await this.handleTempSet(value, 'target_cool');
      });

    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .onGet(async () => {
        return await this.handleTempGet(await this.system_status.getZoneHeatSetpoint());
      })
      .onSet(async (value) => {
        return await this.handleTempSet(value, 'target_heat');
      });
  }

  cToF(temp: number | string): string {
    return ((9.0 / 5.0 * Number(temp)) + 32).toFixed(0);
  }

  fToC(temp: number | string): string {
    return (5.0 / 9.0 * (Number(temp) - 32)).toFixed(4);
  }

  async handleCurrentHeatingCoolingStateGet(): Promise<CharacteristicValue> {
    const current_state = await this.system_status.getMode();
    switch(current_state) {
      case SYSTEM_MODE.OFF:
        return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
      case SYSTEM_MODE.COOL:
        return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
      case SYSTEM_MODE.HEAT:
        return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
      default:
        throw Error(`Unknown current state '${current_state}'`);
    }
  }

  async handleTargetHeatingCoolingStateGet(): Promise<CharacteristicValue> {
    const target_state = await this.system_config.getMode();
    switch(target_state) {
      case SYSTEM_MODE.OFF:
        return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
      case SYSTEM_MODE.COOL:
        return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
      case SYSTEM_MODE.HEAT:
        return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
      case SYSTEM_MODE.AUTO:
        return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
      default:
        throw Error(`Unknown target state '${target_state}'`);
    }
  }

  async handleTargetHeatingCoolingStateSet(value: CharacteristicValue): Promise<void> {
    this.platform.log.info('Triggered SET TargetHeatingCoolingState:', value);
    if (typeof value !== 'number') {
      throw new Error(`Invalid target temp state ${value}.`);
    }
    let target_state: string;
    switch(value) {
      case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
        target_state = SYSTEM_MODE.OFF; break;
      case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
        target_state = SYSTEM_MODE.COOL; break;
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
        target_state = SYSTEM_MODE.HEAT; break;
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
        target_state = SYSTEM_MODE.AUTO; break;
      default:
        throw Error(`Unknown target state ${value}`);
    }

    await this.system_config.set('target_state', target_state);
  }

  async handleTempGet(value: number): Promise<CharacteristicValue> {
    const units = await this.system_status.getUnits();
    return units === 'C' ? value : this.fToC(value);
  }

  async handleTempSet(value: CharacteristicValue, key: string): Promise<void> {
    this.platform.log.info(`Set ${key} to ${value}.`);
    const units = await this.system_status.getUnits();
    if (typeof value !== 'number') {
      throw new Error(`Invalid target temp value ${value}.`);
    }
    await this.system_config.set(
      key,
      units === 'C' ?
        value.toFixed(2) :  // TODO: does carrier api support decimal sets?
        this.cToF(value),
    );
  }

  async handleTemperatureDisplayUnitsGet(): Promise<CharacteristicValue> {
    const units = await this.system_status.getUnits();
    return units === 'C' ?
      this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS :
      this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
  }
}
