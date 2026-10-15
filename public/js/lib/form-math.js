/* Deterministic arithmetic shared by the browser preview and server record validation. */
(() => {
  const limit=Number.MAX_SAFE_INTEGER/100;
  function number(value,label='Amount') {
    if(value==null||String(value).trim()===''||typeof value==='boolean')throw new Error(label+': enter a number');
    const parsed=Number(value);if(!Number.isFinite(parsed)||Math.abs(parsed)>limit)throw new Error(label+': amount is too large or invalid');return parsed;
  }
  function round(value){if(!Number.isFinite(value)||Math.abs(value)>limit)throw new Error('Amount is too large to calculate accurately');return Math.round((value+Math.sign(value)*Number.EPSILON)*100)/100;}
  function line(quantity,price,discount=0){const q=number(quantity,'Quantity'),p=number(price,'Unit price'),d=number(discount,'Discount percentage');if(d<0||d>100)throw new Error('Discount must be between 0 and 100 percent');if(q<=0)throw new Error('Quantity must be greater than zero');if(p<0)throw new Error('Unit price cannot be negative');return round(q*(p*(1-d/100)));}
  function validate(fields) {
    for(const field of fields){
      if(field.format && (field.format!=='currency'||!['number','calculated'].includes(field.type)))throw new Error(field.label+': currency formatting needs a numeric field');
      if(field.currency && (!/^[A-Z]{3}$/.test(field.currency)||!['number','calculated','line_items'].includes(field.type)))throw new Error(field.label+': choose a three-letter currency code for a monetary field');
    }
    const byKey=new Map(fields.map(field=>[field.key,field])),visiting=new Set(),done=new Set();
    function visit(field){if(done.has(field.key))return;if(visiting.has(field.key))throw new Error('Calculation cycle includes '+field.label);visiting.add(field.key);
      if(field.type==='calculated'){
        const calc=field.calculation;if(!calc||!['sum','multiply','subtract','percent'].includes(calc.operator)||!Array.isArray(calc.operands)||!calc.operands.length||calc.operands.length>20)throw new Error(field.label+': configure a calculation');
        if(calc.operator==='percent'&&calc.operands.length!==2)throw new Error(field.label+': percentage needs an amount and a rate');
        for(const path of calc.operands){const parts=String(path).split('.'),source=byKey.get(parts[0]);if(!source)throw new Error(field.label+': unknown field '+path);
          if(parts.length===2){if(source.type!=='line_items'||!['quantity','unit_price','discount_amount','line_total'].includes(parts[1])||calc.operator!=='sum')throw new Error(field.label+': choose a valid item total');}
          else if(parts.length!==1||!['number','calculated'].includes(source.type))throw new Error(field.label+': calculations need numeric fields');
          visit(source);
        }
      }
      visiting.delete(field.key);done.add(field.key);
    }
    fields.forEach(visit);
  }
  function calculate(fields,input){validate(fields);const result={...input},done=new Set(),byKey=new Map(fields.map(field=>[field.key,field]));
    function visit(field){if(field.type!=='calculated'||done.has(field.key))return;const values=field.calculation.operands.map(path=>{
      const [key,column]=path.split('.');const source=byKey.get(key);visit(source);
      if(column){if(!Array.isArray(result[key]))return 0;return round(result[key].reduce((sum,row)=>sum+number(row[column],path),0));}
      return result[key]==null||result[key]===''?0:number(result[key],source.label);
    });
      const op=field.calculation.operator;
      result[field.key]=round(op==='sum'?values.reduce((a,b)=>a+b,0):op==='multiply'?values.reduce((a,b)=>a*b,1):op==='percent'?values[0]*values[1]/100:values.slice(1).reduce((a,b)=>a-b,values[0]));done.add(field.key);
    }
    fields.forEach(visit);return result;
  }
  globalThis.FormMath={number,round,line,validate,calculate};
})();
