export interface ModelRoute {
  name: string;
  models: string[];
}
export interface ModelRoutingSettings {
  configPath: string;
  categories: ModelRoute[];
  agents: ModelRoute[];
  mappings: ModelRoute[];
}
export type ModelRoutingInput = Pick<ModelRoutingSettings, "categories" | "agents" | "mappings">;
