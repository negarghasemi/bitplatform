﻿module Foundation.ViewModel.Implementations {
    @Core.Injectable()
    export class DefaultEntityContextProvider implements Contracts.IEntityContextProvider {

        public constructor( @Core.Inject("GuidUtils") public guidUtils: GuidUtils, @Core.Inject("MetadataProvider") public metadataProvider: Contracts.IMetadataProvider, @Core.Inject("ClientAppProfileManager") public clientAppProfileManager: Core.ClientAppProfileManager) {

        }

        private oDataJSInitPromise: Promise<void> = null;

        private async oDataJSInit(): Promise<void> {

            if (this.oDataJSInitPromise == null) {

                const originalJsonHandlerWrite = window["odatajs"].oData.json.jsonHandler.write;

                window["odatajs"].oData.json.jsonHandler.write = function (request, context) {

                    if (request.headers["Content-Type"] == null)
                        request.headers["Content-Type"] = "application/json";

                    request.headers["Content-Type"] += ";IEEE754Compatible=true";

                    return originalJsonHandlerWrite.apply(this, arguments);

                };

                $data["defaults"].oDataWebApi = true;

                $data["defaults"].parameterResolutionCompatibility = false;

                const originalArrayRequired = $data["Validation"].EntityValidation.prototype.supportedValidations["$data.Array"].required;

                $data["Validation"].EntityValidation.prototype.supportedValidations["$data.Array"].required = function required(value, definedValue) {
                    return originalArrayRequired.apply(this, arguments) && value.length != 0;
                }

                for (let typeName of ["Boolean", "DateTimeOffset", "Decimal", "Float", "Guid", "Int16", "Int32", "Int64", "String"]) {

                    const originalRequired = $data["Validation"].EntityValidation.prototype.supportedValidations[`$data.${typeName}`].required;

                    $data["Validation"].EntityValidation.prototype.supportedValidations[`$data.${typeName}`].required = function required(value, definedValue) {
                        return originalRequired.apply(this, arguments) && value != "";
                    }

                }

                this.oDataJSInitPromise = new Promise<void>(async (resolve, reject) => {

                    try {

                        const metadata = await this.metadataProvider.getMetadata();

                        metadata.Dtos
                            .forEach(dto => {

                                const parts = dto.DtoType.split(".");
                                let jayDataDtoType: any = window;

                                for (let part of parts) {
                                    jayDataDtoType = jayDataDtoType[part];
                                }

                                const memberDefenitions = jayDataDtoType != null ? jayDataDtoType.memberDefinitions : null;

                                if (memberDefenitions != null) {

                                    metadata.Dtos
                                        .forEach(dto => {

                                            for (let memberName in memberDefenitions) {
                                                if (memberName.startsWith("$") && memberDefenitions.hasOwnProperty(memberName)) {
                                                    const memberDefenition = memberDefenitions[memberName];
                                                    const mem = dto.MembersMetadata.find(m => `$${m.DtoMemberName}` == memberName);
                                                    if (mem != null) {
                                                        memberDefenition.required = mem.IsRequired == true;
                                                        if (mem.Pattern != null) {
                                                            memberDefenition.regex = mem.Pattern;
                                                        }
                                                    }
                                                }
                                            }

                                        });

                                }

                            });

                        const originalPrepareRequest = window["odatajs"].oData.utils.prepareRequest;

                        const clientAppProfile = this.clientAppProfileManager.getClientAppProfile();

                        window["odatajs"].oData.utils.prepareRequest = function (request, handler, context) {
                            request.headers = request.headers || {};
                            request.headers["current-time-zone"] = clientAppProfile.currentTimeZone;
                            request.headers["desired-time-zone"] = clientAppProfile.desiredTimeZone;
                            request.headers["client-app-version"] = clientAppProfile.version;
                            request.headers["client-type"] = clientAppProfile.clientType;
                            request.headers["client-culture"] = clientAppProfile.culture;
                            request.headers["client-screen-size"] = clientAppProfile.screenSize;
                            request.headers["client-route"] = location.pathname;
                            request.headers["client-theme"] = clientAppProfile.theme;
                            request.headers["client-debug-mode"] = clientAppProfile.isDebugMode;
                            request.headers["client-date-time"] = new Date().toISOString();
                            if (navigator.language != null)
                                request.headers["system-language"] = navigator.language;
                            if (navigator["systemLanguage"] != null)
                                request.headers["client-sys-language"] = navigator["systemLanguage"];
                            request.headers["client-platform"] = navigator.platform;
                            const results = originalPrepareRequest.apply(this, arguments);
                            if (request.headers["Content-Type"] == null)
                                request.headers["Content-Type"] = "application/json";
                            if (request.headers["Content-Type"].indexOf(";IEEE754Compatible=true") == -1)
                                request.headers["Content-Type"] += ";IEEE754Compatible=true";
                            return results;
                        };

                        const originalRead = window["odatajs"].oData.json.jsonHandler.read;

                        window["odatajs"].oData.json.jsonHandler.read = function (response, context) {

                            if (response.body != null && typeof response.body === "string") {
                                response.body = (response.body as string).replace(/:\s*(\d{14,}.\d{2,})\s*([,\}])/g, ':"$1"$2');
                                // this will change "{ number : 214748364711111.2 }" to "{ number : '214748364711111.2' }"
                            }

                            return originalRead.apply(this, arguments);

                        }

                        resolve();
                    }
                    catch (e) {
                        reject(e);
                        throw e;
                    }
                });
            }

            return this.oDataJSInitPromise;
        }

        @Core.Log()
        public async getContext<TContext extends $data.EntityContext>(contextName: string, config?: { isOffline?: boolean, jayDataConfig?: any }): Promise<TContext> {

            if (config == null)
                config = {};

            if (config.isOffline == null)
                config.isOffline = false;

            if (contextName == null)
                throw new Error("contextName argument may not be null");

            await this.oDataJSInit();

            let cfg = null;

            const baseVal = document.getElementsByTagName("base")[0];

            const oDataServiceHost = `${baseVal != null ? angular.element(baseVal).attr("href") : "/"}odata/${contextName}`;

            if (config.isOffline == false) {
                cfg = {
                    name: "oData",
                    oDataServiceHost: oDataServiceHost,
                    withCredentials: false,
                    maxDataServiceVersion: "4.0"
                };
            }
            else {
                cfg = {
                    provider: "indexedDb", databaseName: contextName + "V" + this.clientAppProfileManager.getClientAppProfile().version
                }
            }

            cfg = angular.extend(cfg, config.jayDataConfig || {});

            const contextType = window[`${contextName}Context`];

            if (contextType == null)
                throw new Error("No entity context could be found named " + contextName);

            if (contextType["isEventsListenersAreAdded"] != true && config.isOffline == true) {

                for (let memberDefenitionKey in contextType.memberDefinitions) {

                    const memberDefenition = contextType.memberDefinitions[memberDefenitionKey];

                    if (memberDefenition == null || memberDefenition.kind != "property" || memberDefenition.elementType == null)
                        continue;

                    memberDefenition.elementType["addEventListener"]("beforeCreate", (sender: any, e: Model.Contracts.ISyncableDto) => {
                        if ((e["context"] != null && e["context"]["ignoreEntityEvents"] != true && e["context"]["storageProvider"].name == "indexedDb") || (e["storeToken"] != null && e["storeToken"].args.provider == "indexedDb")) {
                            const eType = e.getType();
                            const members = eType.memberDefinitions as any;
                            for (let keyMember of members.getKeyProperties()) {
                                if (keyMember.originalType == "Edm.Guid" && e[keyMember.name] == null) {
                                    e[keyMember.name] = this.guidUtils.newGuid();
                                }
                            }
                            if (members["$IsArchived"] != null && e.IsArchived == null)
                                e.IsArchived = false;
                            if (members["$Version"] != null && e.Version == null)
                                e.Version = "0";
                            if (members["$ISV"] != null)
                                e.ISV = false;
                        }
                    });

                    memberDefenition.elementType["addEventListener"]("beforeUpdate", (sender: any, e: Model.Contracts.ISyncableDto) => {
                        if ((e["context"] != null && e["context"]["ignoreEntityEvents"] != true && e["context"]["storageProvider"].name == "indexedDb") || (e["storeToken"] != null && e["storeToken"].args.provider == "indexedDb")) {
                            const eType = e.getType();
                            const members = eType.memberDefinitions;
                            if (members["$ISV"] != null)
                                e.ISV = false;
                        }
                    });

                    memberDefenition.elementType["addEventListener"]("beforeDelete", (sender: any, e: Model.Contracts.ISyncableDto) => {
                        if (((e["context"] != null && e["context"]["ignoreEntityEvents"] != true && e["context"]["storageProvider"].name == "indexedDb") || (e["storeToken"] != null && e["storeToken"].args.provider == "indexedDb") && (e.Version != null && e.Version != "0"))) {
                            const eType = e.getType();
                            const members = eType.memberDefinitions;
                            if (members["$ISV"] != null)
                                e.ISV = false;
                            if (members["$IsArchived"] != null) {
                                e.IsArchived = true;
                                e.entityState = $data.EntityState.Modified;
                            }
                        }
                    });

                }

                contextType["isEventsListenersAreAdded"] = true;
            }

            const context: TContext = new contextType(cfg);
            context.trackChanges = true;
            await context.onReady();

            return context;

        }
    }
}