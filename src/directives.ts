/*
 * Directives are functions that apply changes on the reply object. They can be registered as keys on the voxa
 * application and then used on transitions
 *
 * For example, the reply directive is used as part of the transition to render ask, say, tell, reprompt or directives.
 *
 * return { reply: 'View' }
 */

import { Response } from "ask-sdk-model";
import * as bluebird from "bluebird";
import * as _ from "lodash";
import { DialogflowReply } from ".";
import { AlexaReply } from "../src/platforms/alexa/AlexaReply";
import { VoxaPlatform } from "./platforms/VoxaPlatform";
import { ITransition } from "./StateMachine";
import { IVoxaEvent } from "./VoxaEvent";
import { IVoxaReply } from "./VoxaReply";

export interface IDirectiveClass {
  platform: string; // botframework, dialogflow or alexa
  key: string; // The key in the transition that links to the specific directive

  new (...args: any[]): IDirective;
}

export interface IDirective {
  writeToReply: (
    reply: IVoxaReply,
    event: IVoxaEvent,
    transition: ITransition,
  ) => Promise<void>;
}

export enum EntityOverrideMode {
  Unspecified = "ENTITY_OVERRIDE_MODE_UNSPECIFIED",
  Override = "ENTITY_OVERRIDE_MODE_OVERRIDE",
  Supplement = "ENTITY_OVERRIDE_MODE_SUPPLEMENT",
}

export function sampleOrItem(
  statement: string | string[],
  platform: VoxaPlatform,
): string {
  if (_.isArray(statement)) {
    if (platform.config.test) {
      return _.head(statement) as string;
    }

    return _.sample(statement) as string;
  }

  return statement;
}

export class Reprompt implements IDirective {
  public static key: string = "reprompt";
  public static platform: string = "core";

  constructor(public viewPath: string) {}

  public async writeToReply(
    reply: IVoxaReply,
    event: IVoxaEvent,
    transition: ITransition,
  ): Promise<void> {
    const statement = await event.renderer.renderPath(this.viewPath, event);
    reply.addReprompt(sampleOrItem(statement, event.platform));
  }
}

export interface IAskStatement {
  ask: string;
  reprompt?: string;
}

export class Ask implements IDirective {
  public static key: string = "ask";
  public static platform: string = "core";
  public viewPaths: string[];

  constructor(viewPaths: string | string[]) {
    this.viewPaths = _.isString(viewPaths) ? [viewPaths] : viewPaths;
  }

  public async writeToReply(
    reply: IVoxaReply,
    event: IVoxaEvent,
    transition: ITransition,
  ): Promise<void> {
    transition.flow = "yield";
    transition.say = this.viewPaths;

    for (const viewPath of this.viewPaths) {
      const statement = await event.renderer.renderPath(viewPath, event);
      if (!statement.ask) {
        reply.addStatement(sampleOrItem(statement, event.platform));
      } else {
        this.addStatementToReply(statement, reply, event);
      }
    }
  }

  private addStatementToReply(
    statement: IAskStatement,
    reply: IVoxaReply,
    event: IVoxaEvent,
  ) {
    reply.addStatement(sampleOrItem(statement.ask, event.platform));

    if (statement.reprompt) {
      reply.addReprompt(sampleOrItem(statement.reprompt, event.platform));
    }
  }
}

export class Say implements IDirective {
  public static key: string = "say";
  public static platform: string = "core";

  constructor(public viewPaths: string | string[]) {}

  public async writeToReply(
    reply: IVoxaReply,
    event: IVoxaEvent,
    transition: ITransition,
  ): Promise<void> {
    let viewPaths = this.viewPaths;
    if (_.isString(viewPaths)) {
      viewPaths = [viewPaths];
    }

    await bluebird.mapSeries(viewPaths, async (view: string) => {
      const statement = await event.renderer.renderPath(view, event);
      reply.addStatement(sampleOrItem(statement, event.platform));
    });
  }
}

export class SayP implements IDirective {
  public static key: string = "sayp";
  public static platform: string = "core";

  constructor(public statement: string) {}

  public async writeToReply(
    reply: IVoxaReply,
    event: IVoxaEvent,
    transition: ITransition,
  ): Promise<void> {
    reply.addStatement(this.statement);
  }
}

export class Tell implements IDirective {
  public static key: string = "tell";
  public static platform: string = "core";

  constructor(public viewPath: string) {}

  public async writeToReply(
    reply: IVoxaReply,
    event: IVoxaEvent,
    transition: ITransition,
  ): Promise<void> {
    const statement = await event.renderer.renderPath(this.viewPath, event);
    reply.addStatement(sampleOrItem(statement, event.platform));
    reply.terminate();
    transition.flow = "terminate";
    transition.say = this.viewPath;
  }
}

export class Text implements IDirective {
  public static key: string = "text";
  public static platform: string = "core";

  constructor(public viewPaths: string | string[]) {}
  public async writeToReply(
    reply: IVoxaReply,
    event: IVoxaEvent,
    transition: ITransition,
  ): Promise<void> {
    let viewPaths = this.viewPaths;
    if (_.isString(viewPaths)) {
      viewPaths = [viewPaths];
    }

    await bluebird.mapSeries(viewPaths, async (view: string) => {
      const statement = await event.renderer.renderPath(view, event);
      reply.addStatement(sampleOrItem(statement, event.platform), true);
    });
  }
}

export class TextP implements IDirective {
  public static key: string = "textp";
  public static platform: string = "core";

  constructor(public text: string) {}
  public async writeToReply(
    reply: IVoxaReply,
    event: IVoxaEvent,
    transition: ITransition,
  ): Promise<void> {
    reply.addStatement(this.text, true);
  }
}

export abstract class EntityHelper {
  public generateEntity(entity: any, event: IVoxaEvent): any {
    const source = _.get(event, "rawEvent.originalDetectIntentRequest.source");
    const platformName = _.get(event, "platform.name");
    const platform = source || platformName;

    let newSessionEntity;

    newSessionEntity = entity.reduce(
      (filteredEntity: any, property: any): any => {
        let newEntity;
        let entityMode = _.get(property, "updateBehavior", "REPLACE");

        const name = _.get(property, "name");
        const entities = _.get(property, "entities");

        this.validateEntityName(name);
        this.validateEntity(entities);

        if (platform === "google") {
          entityMode = _.get(
            property,
            "entityOverrideMode",
            "ENTITY_OVERRIDE_MODE_OVERRIDE",
          );

          this.validateEntityBehavior(entityMode, platform);

          newEntity = this.dialogflowSessionEntity(
            property,
            entityMode,
            name,
            event,
          );
        }

        if (platform === "alexa") {
          newEntity = this.alexaDynamicEntity(property, name);
        }

        filteredEntity.push(newEntity);
        return filteredEntity;
      },
      [],
    );

    if (platform === "alexa") {
      const behavior =
        _.chain(entity)
          .map((e) => e.updateBehavior)
          .find()
          .value() || "REPLACE";

      this.validateEntityBehavior(behavior, platform);
      return (newSessionEntity = {
        type: "Dialog.UpdateDynamicEntities",
        types: newSessionEntity,
        updateBehavior: behavior,
      });
    }

    return newSessionEntity;
  }

  protected dialogflowSessionEntity(
    property: any,
    entityOverrideMode: string,
    name: string,
    event: IVoxaEvent,
  ): any {
    return {
      entities: property.entities,
      entityOverrideMode,
      name: `${event.rawEvent.session}/entityTypes/${name}`,
    };
  }

  protected alexaDynamicEntity(property: any, name: string): any {
    function entityValues(prop: any) {
      const entity: any = {};
      if (_.get(prop, "id")) {
        entity.id = prop.id;
      }
      if (_.get(prop, "synonyms") && _.get(prop, "value")) {
        entity.name = {
          synonyms: prop.synonyms,
          value: prop.value,
        };
      }
      return entity;
    }

    const values: any = property.entities.map((entity: any) =>
      entityValues(entity),
    );

    return {
      name,
      values,
    };
  }

  protected validateEntityBehavior(behavior: string, platform: string): any {
    const dialogflowEntityBehaviorList = [
      EntityOverrideMode.Unspecified,
      EntityOverrideMode.Override,
      EntityOverrideMode.Supplement,
    ];

    const alexaEntityBehaviorList = ["REPLACE", "CLEAR"];

    let behaviorList = alexaEntityBehaviorList;
    let error =
      "The updateBehavior is incorrect, please consider use one of the followings: REPLACE or CLEAR";

    if (platform === "google") {
      behaviorList = dialogflowEntityBehaviorList;
      error =
        "The entityOverrideMode is incorrect, please consider use one of the followings: ENTITY_OVERRIDE_MODE_UNSPECIFIED, ENTITY_OVERRIDE_MODE_OVERRIDE or ENTITY_OVERRIDE_MODE_SUPPLEMENT";
    }

    if (!_.includes(behaviorList, behavior)) {
      throw new Error(error);
    }
  }

  protected validateEntity(entities: any): any {
    if (!entities || _.isEmpty(entities)) {
      throw new Error(
        "The entities property is empty or was not provided, please verify",
      );
    }
  }

  protected validateEntityName(name: string): any {
    const regexName = new RegExp(/^[A-Z-_]+$/i);
    if (!name) {
      throw new Error("A name is required for the Entity");
    }

    if (!regexName.test(name)) {
      throw new Error(
        "The name property for the Entity should be only alphabetic characters, and you can include - or _",
      );
    }
  }
}

export class Entity extends EntityHelper implements IDirective {
  public static key: string = "entities";
  public static platform: string = "core";

  public viewPath?: any | any[];

  constructor(viewPath: any | any[]) {
    super();
    this.viewPath = viewPath;
  }

  public async writeToReply(
    reply: IVoxaReply,
    event: IVoxaEvent,
    transition?: ITransition,
  ): Promise<void> {
    let entity: any = this.viewPath;

    const platform = _.get(event, "platform.name");

    if (_.isString(this.viewPath)) {
      entity = await event.renderer.renderPath(this.viewPath, event);
    }

    if (_.isPlainObject(entity)) {
      entity = [entity];
    }

    if (!_.isArray(entity) || _.isEmpty(entity)) {
      throw new Error(
        "Please verify your entity it could be empty or is not an array",
      );
    }

    entity = this.generateEntity(entity, event);

    if (platform === "google") {
      (reply as DialogflowReply).sessionEntityTypes = entity;
    }

    if (platform === "alexa") {
      const response: Response = (reply as AlexaReply).response;
      if (!response.directives) {
        response.directives = [];
      }

      if (_.isArray(response.directives)) {
        response.directives = _.concat(response.directives, entity);
      } else {
        response.directives!.push(entity);
      }
    }
  }
}
