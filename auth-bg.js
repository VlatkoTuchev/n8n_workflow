(function(){
  const canvas = document.getElementById('bg');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let width = 0, height = 0, dpr = Math.max(1, window.devicePixelRatio || 1);
  let points = []; // animated nodes
  let mouse = { x: 0, y: 0, active: false };

  function resize() {
    width = window.innerWidth; height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    initPoints();
  }

  function initPoints(){
    const density = Math.min(90, Math.max(40, Math.floor(width * height / 18000)));
    points = Array.from({ length: density }).map(() => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.8,
      vy: (Math.random() - 0.5) * 0.8,
      r: 1.2 + Math.random() * 1.8
    }));
  }

  function tick(){
    ctx.clearRect(0,0,width,height);
    // gradient wash
    const g = ctx.createRadialGradient(width*0.7, height*0.1, 0, width*0.7, height*0.1, Math.max(width,height));
    g.addColorStop(0, 'rgba(59,130,246,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0,0,width,height);

    // draw connections
    for (let i=0;i<points.length;i++){
      const p = points[i];
      p.x += p.vx; p.y += p.vy;
      if (p.x < -50) p.x = width+50; if (p.x > width+50) p.x = -50;
      if (p.y < -50) p.y = height+50; if (p.y > height+50) p.y = -50;

      // attraction to mouse
      if (mouse.active){
        const dx = mouse.x - p.x, dy = mouse.y - p.y;
        const dist2 = dx*dx + dy*dy;
        const force = Math.min(12000 / (dist2 + 12000), 0.12);
        p.vx += dx * force * 0.0008; p.vy += dy * force * 0.0008;
      }
    }

    // edges
    ctx.lineWidth = 1;
    for (let i=0;i<points.length;i++){
      for (let j=i+1;j<points.length;j++){
        const a = points[i], b = points[j];
        const dx = a.x - b.x, dy = a.y - b.y; const d2 = dx*dx + dy*dy;
        if (d2 < 140*140){
          const alpha = 0.08 * (1 - Math.sqrt(d2)/140);
          ctx.strokeStyle = `rgba(139,92,246,${alpha})`;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }

    // nodes
    for (const p of points){
      ctx.fillStyle = 'rgba(59,130,246,0.75)';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2); ctx.fill();
    }
    requestAnimationFrame(tick);
  }

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', (e)=>{ mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true; });
  window.addEventListener('pointerleave', ()=>{ mouse.active = false; });
  resize();
  tick();
})();


