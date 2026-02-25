import React, { useEffect, useRef, useState } from 'react';
import { init, dispose } from 'klinecharts';

const KLineChartComponent = () => {
  const chartContainerRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const wsRef = useRef(null);
  const depthWsRef = useRef(null); 

  const [currentPrice, setCurrentPrice] = useState('加载中...');
  // 存放买单和卖单的状态，为了防止初次渲染报错，我们给点默认的空数组
  const [orderBook, setOrderBook] = useState({ bids: [], asks: [] });

  useEffect(() => {
    if (!chartContainerRef.current) return;

    // 1. 初始化图表并加上交易量副图
    const chart = init(chartContainerRef.current);
    chartInstanceRef.current = chart;
    chart.createIndicator('VOL', false);

    // 2. 拉取历史数据
    const fetchHistoricalData = async () => {
      try {
        const response = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=500');
        const data = await response.json();

        const formattedData = data.map(item => ({
          timestamp: item[0],
          open: parseFloat(item[1]),
          high: parseFloat(item[2]),
          low: parseFloat(item[3]),
          close: parseFloat(item[4]),
          volume: parseFloat(item[5])
        }));

        chart.applyNewData(formattedData);
        if (formattedData.length > 0) {
          setCurrentPrice(formattedData[formattedData.length - 1].close.toFixed(2));
        }
        
        connectKLineWebSocket();
        connectDepthWebSocket();
      } catch (error) {
        console.error("❌ 拉取历史数据失败:", error);
      }
    };

    // 3. K线实时跳动
    const connectKLineWebSocket = () => {
      const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@kline_1m');
      wsRef.current = ws;
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const kline = message.k;
        const tick = {
          timestamp: kline.t,
          open: parseFloat(kline.o),
          high: parseFloat(kline.h),
          low: parseFloat(kline.l),
          close: parseFloat(kline.c),
          volume: parseFloat(kline.v)
        };
        chart.updateData(tick);
        setCurrentPrice(tick.close.toFixed(2));
      };
    };

    // 🌟 4. 修复后的订单簿深度 WebSocket
    const connectDepthWebSocket = () => {
      const depthWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@depth20@100ms');
      depthWsRef.current = depthWs;
      
      depthWs.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        // 🛡️ 修复：币安返回的字段是 bids 和 asks，并且加上安全判断，防止空数据导致崩溃
        if (data && data.bids && data.asks) {
          setOrderBook({
            bids: data.bids.slice(0, 15),
            asks: data.asks.slice(0, 15).reverse() // 卖盘反转一下，让最便宜的贴近现价
          });
        }
      };
    };

    fetchHistoricalData();

    // 5. 监听浏览器窗口变化
    const handleResize = () => {
      if (chartInstanceRef.current) chartInstanceRef.current.resize();
    };
    window.addEventListener('resize', handleResize);

    // 6. 清理函数
    return () => {
      window.removeEventListener('resize', handleResize);
      if (wsRef.current) wsRef.current.close();
      if (depthWsRef.current) depthWsRef.current.close(); 
      if (chartInstanceRef.current) dispose(chartContainerRef.current);
    };
  }, []);

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#181a20', display: 'flex', flexDirection: 'column' }}>
      
      {/* 顶部信息栏 */}
      <div style={{ 
        height: '50px', padding: '0 20px', backgroundColor: '#181a20', 
        borderBottom: '1px solid #2b313f', display: 'flex', alignItems: 'center', gap: '20px'
      }}>
         <b style={{ color: '#eaecef', fontSize: '20px', fontFamily: 'sans-serif' }}>BTC / USDT</b> 
         <span style={{ color: '#2ebd85', fontSize: '18px', fontWeight: 'bold', fontFamily: 'monospace' }}>
           $ {currentPrice}
         </span>
      </div>
      
      {/* 核心布局：左右两部分 */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        
        {/* 左侧：K线图表 */}
        <div ref={chartContainerRef} style={{ flex: 1 }} />

        {/* 右侧：订单簿盘口 */}
        <div style={{ 
          width: '320px', 
          backgroundColor: '#181a20', 
          borderLeft: '1px solid #2b313f',
          display: 'flex',
          flexDirection: 'column',
          fontSize: '12px',
          fontFamily: 'monospace' 
        }}>
          {/* 表头 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 15px', color: '#848e9c' }}>
            <span>价格(USDT)</span>
            <span>数量(BTC)</span>
          </div>

          {/* 卖盘区域 (红色) */}
          <div style={{ display: 'flex', flexDirection: 'column', padding: '0 15px' }}>
            {orderBook.asks.map((ask, index) => (
              <div key={`ask-${index}`} style={{ display: 'flex', justifyContent: 'space-between', lineHeight: '20px' }}>
                <span style={{ color: '#f6465d' }}>{parseFloat(ask[0]).toFixed(2)}</span>
                <span style={{ color: '#eaecef' }}>{parseFloat(ask[1]).toFixed(4)}</span>
              </div>
            ))}
          </div>

          {/* 中间现价分隔区 */}
          <div style={{ 
            padding: '10px 15px', margin: '5px 0', 
            fontSize: '18px', fontWeight: 'bold', color: '#2ebd85',
            borderTop: '1px solid #2b313f', borderBottom: '1px solid #2b313f',
            display: 'flex', alignItems: 'center'
          }}>
            {currentPrice} <span style={{fontSize: '12px', color: '#848e9c', marginLeft: '10px'}}>最新成交价</span>
          </div>

          {/* 买盘区域 (绿色) */}
          <div style={{ display: 'flex', flexDirection: 'column', padding: '0 15px' }}>
            {orderBook.bids.map((bid, index) => (
              <div key={`bid-${index}`} style={{ display: 'flex', justifyContent: 'space-between', lineHeight: '20px' }}>
                <span style={{ color: '#0ecb81' }}>{parseFloat(bid[0]).toFixed(2)}</span>
                <span style={{ color: '#eaecef' }}>{parseFloat(bid[1]).toFixed(4)}</span>
              </div>
            ))}
          </div>
          
        </div>
      </div>
    </div>
  );
};

export default KLineChartComponent;