/* Measured consecutive-fringe diagnostic. Independent of the fit objective. */
"use strict";
const XRDFringes = (() => {
  function number(value,label) {
    if (!["number","string"].includes(typeof value) || typeof value === "string" && !value.trim() || !Number.isFinite(Number(value))) throw new Error(`${label} must be a finite number`);
    return Number(value);
  }
  const mean = a => a.reduce((s,v)=>s+v,0)/a.length;
  const median = a => {const s=[...a].sort((a,b)=>a-b),i=Math.floor(s.length/2);return s.length%2?s[i]:(s[i-1]+s[i])/2;};
  function estimate(request) {
    if (!request || typeof request!=="object" || Array.isArray(request)) throw new Error("Fringe request must be an object");
    const wavelength=number(request.wavelength,"wavelength"),offset=number(request.angle_offset_deg === undefined ? 0 : request.angle_offset_deg,"angle_offset_deg");
    if (wavelength<=0) throw new Error("wavelength must be positive");
    const m=request.measurement;
    const result={status:"no_measurement",peak_angles:[],q_slope:null,thickness_nm:null,relative_scatter:null,index_residual:null,message_codes:["no_measurement"],method:"automatic",orders:[],q_intercept:null,angular_residual_rms_deg:null,predicted_peak_angles:[],angular_residuals_deg:[]};
    if (m == null) return result;
    if (typeof m!=="object" || Array.isArray(m)) throw new Error("Fringe measurement must be an object");
    if (m.angles == null || Array.isArray(m.angles) && !m.angles.length) return result;
    if (!Array.isArray(m.angles) || !Array.isArray(m.intensities) || m.angles.length!==m.intensities.length || m.angles.length>20001) throw new Error("Fringe measurement needs matching arrays of at most 20,001 points");
    const x=m.angles.map(v=>number(v,"angle")),y=m.intensities.map(v=>number(v,"intensity"));
    if (x.some((v,i)=>!(v-offset>0&&v-offset<180)||i&&v<=x[i-1])) throw new Error("Fringe angles must increase within the physical 0–180 degree range");
    if(y.some(v=>v<0))throw new Error("Fringe intensities must be nonnegative");
    const roi=request.roi === undefined ? [x[0],x[x.length-1]] : request.roi;
    if(!Array.isArray(roi)||roi.length!==2)throw new Error("Fringe ROI needs lower and upper angles");
    const [lo,hi]=roi.map(v=>number(v,"Fringe ROI"));
    if(!(x[0]<=lo&&lo<hi&&hi<=x[x.length-1]))throw new Error("Fringe ROI must increase within the measured scan");
    const manual=request.manual_peaks;
    if(manual!=null&&!Array.isArray(manual))throw new Error("Manual fringe peaks must be an array of consecutive angles");
    let peaks=[];
    if(manual?.length){
      peaks=manual.map(v=>number(v,"Manual fringe peak"));
      if(peaks.some((v,i)=>!(lo<=v&&v<=hi)||i&&v<=peaks[i-1]))throw new Error("Manual fringe peaks must increase within the selected ROI");
      result.method="manual";
    }else{
      const idx=x.map((v,i)=>lo<=v&&v<=hi?i:-1).filter(i=>i>=0),xx=idx.map(i=>x[i]),yy=idx.map(i=>y[i]);
      if(yy.length>=25&&Math.max(...yy)>0){
        const peak=Math.max(...yy),logs=yy.map(v=>Math.log10(Math.max(v/peak,1e-12)));
        const weights=[1,2,3,2,1],smooth=logs.map((_,i)=>weights.reduce((s,w,j)=>s+w*logs[Math.min(logs.length-1,Math.max(0,i+j-2))],0)/9);
        const radius=Math.max(5,Math.min(100,Math.floor(logs.length/10))),prefix=[0];
        for(const v of smooth)prefix.push(prefix[prefix.length-1]+v);
        const signal=smooth.map((v,i)=>{const a=Math.max(0,i-radius),b=Math.min(smooth.length,i+radius+1);return v-(prefix[b]-prefix[a])/(b-a);});
        const interior=signal.slice(radius,-radius),avg=mean(interior),rms=Math.sqrt(mean(interior.map(v=>(v-avg)**2)));
        const threshold=Math.max(.01,.15*rms),reach=Math.max(3,Math.floor(radius/2));
        for(let i=radius;i<signal.length-radius;i++)if(signal[i]>signal[i-1]&&signal[i]>=signal[i+1]){
          const prominence=signal[i]-Math.max(Math.min(...signal.slice(i-reach,i)),Math.min(...signal.slice(i+1,i+reach+1)));
          if(prominence>=threshold){if(peaks.length&&i-peaks[peaks.length-1]<3){if(signal[i]>signal[peaks[peaks.length-1]])peaks[peaks.length-1]=i;}else peaks.push(i);}
        }
        peaks=peaks.map(i=>xx[i]);
      }
    }
    const rawOrders=request.manual_orders;
    if(rawOrders!=null&&!Array.isArray(rawOrders))throw new Error("Fringe orders must be an array of increasing integers");
    let orders;
    if(rawOrders?.length){
      if(!manual?.length||rawOrders.length!==peaks.length)throw new Error("Fringe orders must match the manual maximum angles");
      orders=rawOrders.map(v=>number(v,"Fringe order"));
      if(orders.some((v,i)=>!Number.isInteger(v)||Math.abs(v)>10000||i&&v<=orders[i-1]))throw new Error("Fringe orders must be increasing integers within -10,000 to 10,000");
    }else orders=peaks.map((_,i)=>i);
    Object.assign(result,{peak_angles:peaks,orders,roi:[lo,hi],status:"insufficient",message_codes:["insufficient_peaks"]});
    if(peaks.length<4)return result;
    const q=peaks.map(v=>4*Math.PI/wavelength*Math.sin((v-offset)*Math.PI/360)),n=q.length,mid=mean(orders),avg=mean(q);
    const slope=q.reduce((s,v,i)=>s+(orders[i]-mid)*(v-avg),0)/orders.reduce((s,v)=>s+(v-mid)**2,0);
    if (!(slope>0)) return Object.assign(result,{status:"irregular",message_codes:["irregular_spacing"]});
    const intervals=q.slice(1).map((v,i)=>(v-q[i])/(orders[i+1]-orders[i])),step=mean(intervals),scatter=Math.sqrt(mean(intervals.map(v=>(v-step)**2)))/step;
    const residual=Math.sqrt(mean(q.map((v,i)=>(v-(avg+slope*(orders[i]-mid)))**2)))/slope,typical=median(intervals);
    const args=orders.map(i=>(avg+slope*(i-mid))*wavelength/(4*Math.PI)),physical=args.every(v=>v>0&&v<1);
    const predicted=physical?args.map(v=>2*Math.asin(v)*180/Math.PI+offset):[];
    const errors=physical?peaks.map((v,i)=>v-predicted[i]):[];
    const angular=physical?Math.sqrt(mean(errors.map(v=>v*v))):null;
    const irregular=scatter>.12||residual>.15||intervals.some(v=>!(.65<=v/typical&&v/typical<=1.35))||!physical;
    return Object.assign(result,{q_slope:slope,q_intercept:avg-slope*mid,predicted_peak_angles:predicted,angular_residuals_deg:errors,angular_residual_rms_deg:angular,relative_scatter:scatter,index_residual:residual,status:irregular?"irregular":"ok",thickness_nm:irregular?null:2*Math.PI/slope/10,message_codes:irregular?["irregular_spacing"]:[rawOrders?.length?"assigned_orders_assumed":"consecutive_orders_assumed","scatter_not_uncertainty"]});
  }
  return {estimate};
})();
if(typeof module!=="undefined"&&module.exports)module.exports=XRDFringes;
