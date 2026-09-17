import {pathToFileURL} from "node:url";
import {startService} from "../tool-events/service.mjs";
export {EventStore as WakeStore,startService} from "../tool-events/service.mjs";
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await startService();
