import {ApiError} from './openhands.mjs';
export function validateDeliveryValidation(value){
 if(value===undefined)return;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['command','timeoutSeconds','autoRepair'].includes(k))||typeof value.command!=='string'||!value.command.trim()||value.command.length>4000||value.command.includes('\0')||value.timeoutSeconds!==undefined&&(!Number.isInteger(value.timeoutSeconds)||value.timeoutSeconds<5||value.timeoutSeconds>300)||value.autoRepair!==undefined&&typeof value.autoRepair!=='boolean')throw new ApiError('交付检查须包含命令，可选 5–300 秒超时及 autoRepair 布尔值。');
 return {command:value.command.trim(),timeoutSeconds:value.timeoutSeconds??60,autoRepair:value.autoRepair??true};
}
