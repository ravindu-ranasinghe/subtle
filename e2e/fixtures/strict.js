// A live canvas stream rather than a recorded file: currentTime advances
      // for as long as the test needs and never ends, and there is no minutes
      // long recording step before the page is usable. The e2e does not seek,
      // so losing seekability costs nothing.
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      const video = document.querySelector('#v');
      video.srcObject = canvas.captureStream(15);
      setInterval(() => {
        const t = video.currentTime;
        ctx.fillStyle = `hsl(${(t * 30) % 360} 40% 18%)`;
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#ffffff44';
        ctx.font = '40px system-ui';
        ctx.fillText(`${t.toFixed(1)}s`, 24, 60);
      }, 66);
      window.__videoReady = true;
