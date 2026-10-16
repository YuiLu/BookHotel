// The default profile remains D-Reserve; engine selection also supports Tripla.
export const DEFAULT_HOTEL_CODE='0000001834';
export const DEFAULT_HOTEL={engine:'d-reserve',code:DEFAULT_HOTEL_CODE,name:'秀峰閣 湖月',lodgerTypeCodes:[0,1,2,3,4,6],
  questions:[{code:8153,title:'交通手段',formType:'SELECT_ONE',checkoutKey:'transport'}]};
export const LODGER_TYPES=[{key:'adults',code:0,type:'ADULT'},{key:'childA',code:1,type:'CHILD_A'},
  {key:'childB',code:2,type:'CHILD_B'},{key:'childC',code:3,type:'CHILD_C'},
  {key:'childD',code:4,type:'CHILD_D'},{key:'infant',code:6,type:'CHILD_F'}];
