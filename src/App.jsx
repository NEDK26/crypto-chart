import React from 'react';
import KLineChartComponent from './KLineChartComponent';
// 把自带的默认样式注释掉，防止它干扰我们的图表排版
// import './App.css'; 

function App() {
  return (
    <div style={{ margin: 0, padding: 0 }}>
      <KLineChartComponent />
    </div>
  );
}

export default App;