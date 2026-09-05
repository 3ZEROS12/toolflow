const fs = require('fs');
let code = fs.readFileSync('C:/Users/Jason/.pi/agent/extensions/toolflow/ui.ts', 'utf8');
if (!code.includes('PromptsManager')) {
  code = code.replace('import { EcosystemTaxonomy', 'import { PromptsManager, PromptItemInfo } from "./prompts_manager.js";
import { EcosystemTaxonomy');
}
fs.writeFileSync('C:/Users/Jason/.pi/agent/extensions/toolflow/ui.ts', code, 'utf8');
console.log('Import added');