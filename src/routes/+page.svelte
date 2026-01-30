<script lang="ts">
  import { MapLibre, NavigationControl, ScaleControl, GlobeControl, Marker, GeoJSONSource, LineLayer } from 'svelte-maplibre-gl';
  import type { MapMouseEvent } from 'maplibre-gl';

  interface Point {
    lat: number;
    lng: number;
    type: 'start' | 'end';
  }

  interface RouteSegment {
    sequence: number;
    node: number;
    edge: number;
    cost: number;
    accumulatedCost: number;
    geometry: any;
    name: string;
    length: number;
  }

  interface Route {
    routeType: 'shortest' | 'fastest';
    label: string;
    startNode: number;
    endNode: number;
    waypoints?: Array<{ lat: number; lon: number; nodeId: number }>;
    totalCost: number;
    totalDistance: number;
    totalMinutes: number;
    estimatedDuration: number;
    segments: RouteSegment[];
    legs?: Array<{
      from: any;
      to: any;
      distance: number;
      minutes: number;
    }>;
  }

  interface AvoidArea {
    lat: number;
    lon: number;
    radius: number;
  }

  interface RouteResult {
    shortest: Route | null;
    fastest: Route | null;
    routes: Route[];
    waypoints?: Array<{ lat: number; lon: number }>;
    avoidAreas?: AvoidArea[];
    constraints?: {
      avoidMotorways: boolean;
      vehicleWidth: number | null;
      vehicleHeight: number | null;
      avoidAreas: number;
    };
  }

  let startPoint: Point | null = null;
  let endPoint: Point | null = null;
  let waypoints: Point[] = [];
  let avoidAreas: AvoidArea[] = [];
  let isSelectingStart = true;
  let isSelectingWaypoint = false;
  let isSelectingAvoidArea = false;
  let isSearching = false;
  let routeResult: RouteResult | null = null;
  let selectedRouteType: 'shortest' | 'fastest' = 'fastest';
  let searchError: string | null = null;
  let avoidAreaRadius = 500; // デフォルト半径500m
  
  // 車両制約オプション
  let avoidMotorways = false;
  let vehicleWidth: number | null = null;
  let vehicleHeight: number | null = null;
  let showAdvancedOptions = false;
  let selectedVehicleType: string | null = null;

  // 車両タイプ定義
  const vehicleTypes = [
    { id: 'kei', label: '軽自動車', emoji: '🚗', width: 1.48, height: 2.0 },
    { id: 'small', label: '乗用車(小型)', emoji: '🚙', width: 1.7, height: 2.0 },
    { id: 'normal', label: '乗用車(普通)', emoji: '🚘', width: 2.5, height: 3.8 },
    { id: 'truck-medium', label: 'トラック(中型)', emoji: '🚚', width: 2.5, height: 3.8 },
    { id: 'truck-large', label: 'トラック(大型)', emoji: '🚛', width: 2.5, height: 3.8 },
    { id: 'special', label: '特大型', emoji: '🚜', width: 3.0, height: 4.0 }
  ];

  function selectVehicleType(typeId: string) {
    selectedVehicleType = typeId;
    const vehicle = vehicleTypes.find(v => v.id === typeId);
    if (vehicle) {
      vehicleWidth = vehicle.width;
      vehicleHeight = vehicle.height;
    }
  }

  function clearVehicleSelection() {
    selectedVehicleType = null;
    vehicleWidth = null;
    vehicleHeight = null;
  }

  function handleMapClick(event: MapMouseEvent) {
    const { lng, lat } = event.lngLat;
    
    if (isSelectingAvoidArea) {
      // 回避エリアを追加
      avoidAreas = [...avoidAreas, { lat, lon: lng, radius: avoidAreaRadius }];
    } else if (isSelectingWaypoint) {
      // 経由地を追加（連続してクリック可能）
      waypoints = [...waypoints, { lat, lng, type: 'waypoint' }];
    } else if (!startPoint) {
      // 開始地点が未設定の場合
      startPoint = { lat, lng, type: 'start' };
    } else if (!endPoint && !isSelectingWaypoint) {
      // 終了地点が未設定で経由地選択モードでない場合
      endPoint = { lat, lng, type: 'end' };
    }
    
    // 新しい地点が設定されたら、既存のルートをクリア
    routeResult = null;
    searchError = null;
  }

  function clearPoints() {
    startPoint = null;
    endPoint = null;
    waypoints = [];
    avoidAreas = [];
    isSelectingStart = true;
    isSelectingWaypoint = false;
    isSelectingAvoidArea = false;
    routeResult = null;
    searchError = null;
  }

  function removeWaypoint(index: number) {
    waypoints = waypoints.filter((_, i) => i !== index);
    routeResult = null;
    searchError = null;
  }

  function removeAvoidArea(index: number) {
    avoidAreas = avoidAreas.filter((_, i) => i !== index);
    routeResult = null;
    searchError = null;
  }

  function formatCoordinate(value: number, isLat: boolean) {
    const direction = isLat ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
    return `${Math.abs(value).toFixed(6)}°${direction}`;
  }

  function formatDistance(meters: number): string {
    if (meters < 1000) {
      return `${meters.toFixed(0)}m`;
    }
    return `${(meters / 1000).toFixed(2)}km`;
  }

  function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (hours > 0) {
      return `${hours}時間${minutes}分`;
    }
    return `${minutes}分`;
  }

  function formatDurationFromMinutes(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    
    if (hours > 0) {
      return `${hours}時間${mins}分`;
    }
    return `${mins}分`;
  }

  async function searchRoute() {
    if (!startPoint || !endPoint) return;

    isSearching = true;
    searchError = null;

    try {
      const response = await fetch('/api/routing/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startLat: startPoint.lat,
          startLon: startPoint.lng,
          endLat: endPoint.lat,
          endLon: endPoint.lng,
          waypoints: waypoints.map(wp => ({ lat: wp.lat, lon: wp.lng })),
          avoidAreas,
          avoidMotorways,
          vehicleWidth,
          vehicleHeight
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'ルート検索に失敗しました');
      }

      routeResult = await response.json();
    } catch (error) {
      console.error('Route search error:', error);
      searchError = error instanceof Error ? error.message : 'ルート検索中にエラーが発生しました';
    } finally {
      isSearching = false;
    }
  }

  // 選択されたルートを取得
  $: selectedRoute = routeResult ? 
    (selectedRouteType === 'shortest' ? routeResult.shortest : routeResult.fastest) : null;

  // 選択されたルートのGeoJSONを作成
  $: selectedRouteGeoJSON = selectedRoute && selectedRoute.segments ? (() => {
    const geometries = selectedRoute.segments
      .filter(segment => segment.geometry)
      .map(segment => segment.geometry);

    if (geometries.length > 0) {
      return {
        type: 'FeatureCollection',
        features: geometries.map((geom, index) => ({
          type: 'Feature',
          geometry: geom,
          properties: {
            segment: index,
            routeType: selectedRoute.routeType
          },
        })),
      };
    }
    return null;
  })() : null;

  // 両方のルートを薄く表示するためのGeoJSON
  $: allRoutesGeoJSON = routeResult ? (() => {
    const routes = [];
    
    if (routeResult.shortest) {
      const shortestGeometries = routeResult.shortest.segments
        .filter(segment => segment.geometry)
        .map(segment => segment.geometry);
      
      if (shortestGeometries.length > 0) {
        routes.push({
          type: 'Feature',
          geometry: {
            type: 'MultiLineString',
            coordinates: shortestGeometries.map(g => g.coordinates)
          },
          properties: {
            routeType: 'shortest',
            selected: selectedRouteType === 'shortest'
          }
        });
      }
    }

    if (routeResult.fastest) {
      const fastestGeometries = routeResult.fastest.segments
        .filter(segment => segment.geometry)
        .map(segment => segment.geometry);
      
      if (fastestGeometries.length > 0) {
        routes.push({
          type: 'Feature',
          geometry: {
            type: 'MultiLineString',
            coordinates: fastestGeometries.map(g => g.coordinates)
          },
          properties: {
            routeType: 'fastest',
            selected: selectedRouteType === 'fastest'
          }
        });
      }
    }

    return routes.length > 0 ? {
      type: 'FeatureCollection',
      features: routes
    } : null;
  })() : null;
</script>

<div class="flex h-screen">
  <!-- 左側パネル -->
  <div class="w-80 bg-white shadow-lg z-10 p-4 overflow-y-auto">
    <h1 class="text-2xl font-bold mb-4">pgRouting Demo</h1>
    
    <div class="mb-6">
      <h2 class="text-lg font-semibold mb-2">使い方</h2>
      <p class="text-sm text-gray-600">
        地図上をクリックして開始地点と終了地点を設定してください。
      </p>
    </div>

    <div class="mb-6">
      <h3 class="text-md font-semibold mb-2">
        {#if isSelectingAvoidArea}
          回避エリアを選択中（クリックで追加）
        {:else if isSelectingWaypoint}
          経由地を選択中（クリックで追加）
        {:else if !startPoint}
          開始地点を選択
        {:else if !endPoint}
          終了地点を選択
        {:else}
          ルート設定完了
        {/if}
      </h3>
      {#if isSelectingWaypoint}
        <p class="text-xs text-gray-600">
          経由地は自動的に順番に挿入されます
        </p>
      {:else if isSelectingAvoidArea}
        <p class="text-xs text-gray-600">
          クリックした地点を中心に半径{avoidAreaRadius}mの円形エリアを回避します
        </p>
      {/if}
    </div>

    <!-- 座標表示 -->
    <div class="space-y-4">
      {#if startPoint}
        <div class="bg-green-50 p-3 rounded-lg">
          <h4 class="font-semibold text-green-800 mb-1">開始地点</h4>
          <p class="text-sm">
            緯度: {formatCoordinate(startPoint.lat, true)}<br>
            経度: {formatCoordinate(startPoint.lng, false)}
          </p>
        </div>
      {/if}

      {#each waypoints as waypoint, index}
        <div class="bg-yellow-50 p-3 rounded-lg relative">
          <button
            class="absolute top-2 right-2 text-yellow-600 hover:text-yellow-800"
            on:click={() => removeWaypoint(index)}
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <h4 class="font-semibold text-yellow-800 mb-1">経由地 {index + 1}</h4>
          <p class="text-sm">
            緯度: {formatCoordinate(waypoint.lat, true)}<br>
            経度: {formatCoordinate(waypoint.lng, false)}
          </p>
        </div>
      {/each}

      {#if endPoint}
        <div class="bg-red-50 p-3 rounded-lg">
          <h4 class="font-semibold text-red-800 mb-1">終了地点</h4>
          <p class="text-sm">
            緯度: {formatCoordinate(endPoint.lat, true)}<br>
            経度: {formatCoordinate(endPoint.lng, false)}
          </p>
        </div>
      {/if}

      {#each avoidAreas as area, index}
        <div class="bg-gray-50 p-3 rounded-lg relative">
          <button
            class="absolute top-2 right-2 text-gray-600 hover:text-gray-800"
            on:click={() => removeAvoidArea(index)}
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <h4 class="font-semibold text-gray-800 mb-1">回避エリア {index + 1}</h4>
          <p class="text-sm">
            緯度: {formatCoordinate(area.lat, true)}<br>
            経度: {formatCoordinate(area.lon, false)}<br>
            半径: {area.radius}m
          </p>
        </div>
      {/each}
    </div>


    <!-- アクションボタン -->
    <div class="mt-6 space-y-2">
      {#if startPoint}
        <!-- 経由地追加ボタン -->
        {#if !isSelectingWaypoint && !isSelectingAvoidArea}
          <button
            class="w-full bg-yellow-500 text-white px-4 py-2 rounded hover:bg-yellow-600 transition-colors text-sm"
            on:click={() => isSelectingWaypoint = true}
          >
            <svg class="inline-block w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
            経由地を追加
          </button>
        {:else if isSelectingWaypoint}
          <button
            class="w-full bg-gray-500 text-white px-4 py-2 rounded hover:bg-gray-600 transition-colors text-sm"
            on:click={() => isSelectingWaypoint = false}
          >
            <svg class="inline-block w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
            経由地の追加を終了
          </button>
        {/if}

        <!-- 回避エリア追加ボタン -->
        {#if !isSelectingAvoidArea && !isSelectingWaypoint}
          <button
            class="w-full bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700 transition-colors text-sm"
            on:click={() => isSelectingAvoidArea = true}
          >
            <svg class="inline-block w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
            回避エリアを追加
          </button>
        {:else if isSelectingAvoidArea}
          <button
            class="w-full bg-gray-500 text-white px-4 py-2 rounded hover:bg-gray-600 transition-colors text-sm"
            on:click={() => isSelectingAvoidArea = false}
          >
            <svg class="inline-block w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
            回避エリアの追加を終了
          </button>
        {/if}
      {/if}

      {#if startPoint && endPoint}
        <button
          class="w-full bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 transition-colors disabled:bg-blue-300"
          on:click={searchRoute}
          disabled={isSearching}
        >
          {isSearching ? '検索中...' : 'ルート検索'}
        </button>
      {/if}
      
      {#if startPoint || endPoint || waypoints.length > 0}
        <button
          class="w-full bg-gray-500 text-white px-4 py-2 rounded hover:bg-gray-600 transition-colors"
          on:click={clearPoints}
        >
          すべてクリア
        </button>
      {/if}
    </div>

    <!-- 詳細オプション -->
    <div class="mt-6">
      <button
        class="w-full text-left text-sm font-medium text-gray-700 flex items-center justify-between"
        on:click={() => showAdvancedOptions = !showAdvancedOptions}
      >
        <span>詳細オプション</span>
        <svg class="w-4 h-4 transition-transform {showAdvancedOptions ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      
      {#if showAdvancedOptions}
        <div class="mt-4 space-y-4 p-4 bg-gray-50 rounded-lg">
          <!-- 高速道路回避 -->
          <label class="flex items-center space-x-2">
            <input
              type="checkbox"
              bind:checked={avoidMotorways}
              class="rounded text-blue-600"
            />
            <span class="text-sm">高速道路を避ける</span>
          </label>
          
          <!-- 車両タイプ選択 -->
          <div>
            <label class="text-sm font-medium text-gray-700 mb-2 block">
              車両タイプを選択
            </label>
            <div class="grid grid-cols-2 gap-2">
              {#each vehicleTypes as vehicle}
                <button
                  class="p-2 text-xs border rounded-lg transition-all {selectedVehicleType === vehicle.id ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-300 bg-white hover:bg-gray-50'}"
                  on:click={() => selectVehicleType(vehicle.id)}
                >
                  <span class="text-lg">{vehicle.emoji}</span>
                  <span class="block">{vehicle.label}</span>
                  <span class="text-xs text-gray-500">
                    幅{vehicle.width}m / 高{vehicle.height}m
                  </span>
                </button>
              {/each}
            </div>
            
            {#if selectedVehicleType}
              <button
                class="mt-2 text-xs text-blue-600 hover:text-blue-700"
                on:click={clearVehicleSelection}
              >
                選択をクリア
              </button>
            {/if}
          </div>
          
          <!-- 手動入力 -->
          <details class="text-sm">
            <summary class="cursor-pointer text-gray-600 hover:text-gray-800">
              サイズを手動で入力
            </summary>
            <div class="mt-3 space-y-3">
              <!-- 車両幅 -->
              <div>
                <label class="text-sm font-medium text-gray-700">
                  車両幅 (メートル)
                </label>
                <input
                  type="number"
                  bind:value={vehicleWidth}
                  placeholder="例: 2.5"
                  step="0.1"
                  min="0"
                  class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
              
              <!-- 車両高さ -->
              <div>
                <label class="text-sm font-medium text-gray-700">
                  車両高さ (メートル)
                </label>
                <input
                  type="number"
                  bind:value={vehicleHeight}
                  placeholder="例: 3.5"
                  step="0.1"
                  min="0"
                  class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
            </div>
          </details>

          <!-- 回避エリア半径設定 -->
          <div class="border-t pt-3">
            <label class="text-sm font-medium text-gray-700">
              回避エリアの半径 (メートル)
            </label>
            <input
              type="number"
              bind:value={avoidAreaRadius}
              placeholder="500"
              step="100"
              min="100"
              max="5000"
              class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <p class="text-xs text-gray-500 mt-1">
              回避エリアの中心からの半径を指定します
            </p>
          </div>
          
          <p class="text-xs text-gray-500">
            ※ 車両サイズを指定すると、通行可能な道路のみを使用してルートを計算します
          </p>
        </div>
      {/if}
    </div>

    <!-- エラー表示 -->
    {#if searchError}
      <div class="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
        <p class="text-sm text-red-600">{searchError}</p>
      </div>
    {/if}

    <!-- ルートタイプ選択 -->
    {#if routeResult && routeResult.routes.length > 0}
      <div class="mt-6 space-y-2">
        <div class="flex justify-between items-center mb-2">
          <h3 class="font-semibold text-gray-800">ルートを選択</h3>
          {#if waypoints.length > 0}
            <span class="text-xs text-gray-600">経由地: {waypoints.length}箇所</span>
          {/if}
        </div>
        <div class="space-y-2">
          {#if routeResult.shortest}
            <button
              class="w-full p-3 rounded-lg border-2 transition-all {selectedRouteType === 'shortest' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}"
              on:click={() => selectedRouteType = 'shortest'}
            >
              <div class="flex justify-between items-center">
                <span class="font-medium {selectedRouteType === 'shortest' ? 'text-blue-700' : 'text-gray-700'}">
                  最短経路
                </span>
                <span class="text-sm {selectedRouteType === 'shortest' ? 'text-blue-600' : 'text-gray-600'}">
                  {formatDistance(routeResult.shortest.totalDistance)}
                </span>
              </div>
              <div class="text-sm text-gray-600 mt-1">
                所要時間: {formatDurationFromMinutes(routeResult.shortest.totalMinutes)}
              </div>
            </button>
          {/if}
          
          {#if routeResult.fastest}
            <button
              class="w-full p-3 rounded-lg border-2 transition-all {selectedRouteType === 'fastest' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}"
              on:click={() => selectedRouteType = 'fastest'}
            >
              <div class="flex justify-between items-center">
                <span class="font-medium {selectedRouteType === 'fastest' ? 'text-blue-700' : 'text-gray-700'}">
                  最速経路
                </span>
                <span class="text-sm {selectedRouteType === 'fastest' ? 'text-blue-600' : 'text-gray-600'}">
                  {formatDurationFromMinutes(routeResult.fastest.totalMinutes)}
                </span>
              </div>
              <div class="text-sm text-gray-600 mt-1">
                距離: {formatDistance(routeResult.fastest.totalDistance)}
              </div>
            </button>
          {/if}
        </div>
      </div>
    {/if}

    <!-- 選択されたルートの詳細情報 -->
    {#if selectedRoute}
      <div class="mt-4 p-4 bg-blue-50 rounded-lg">
        <h3 class="font-semibold text-blue-800 mb-2">{selectedRoute.label}の詳細</h3>
        <div class="space-y-1 text-sm">
          <p><span class="font-medium">総距離:</span> {formatDistance(selectedRoute.totalDistance)}</p>
          <p><span class="font-medium">所要時間:</span> {formatDurationFromMinutes(selectedRoute.totalMinutes)}</p>
          <p><span class="font-medium">セグメント数:</span> {selectedRoute.segments.length}</p>
        </div>
        
        {#if routeResult?.constraints && (routeResult.constraints.avoidMotorways || routeResult.constraints.vehicleWidth || routeResult.constraints.vehicleHeight)}
          <div class="mt-3 pt-3 border-t border-blue-200">
            <p class="text-xs font-medium text-blue-700 mb-1">適用された制約:</p>
            <div class="text-xs text-blue-600 space-y-0.5">
              {#if routeResult.constraints.avoidMotorways}
                <p>• 高速道路を回避</p>
              {/if}
              {#if selectedVehicleType}
                {@const vehicle = vehicleTypes.find(v => v.id === selectedVehicleType)}
                {#if vehicle}
                  <p>• 車両タイプ: {vehicle.emoji} {vehicle.label}</p>
                {/if}
              {/if}
              {#if routeResult.constraints.vehicleWidth}
                <p>• 車両幅: {routeResult.constraints.vehicleWidth}m</p>
              {/if}
              {#if routeResult.constraints.vehicleHeight}
                <p>• 車両高: {routeResult.constraints.vehicleHeight}m</p>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- 地図 -->
  <div class="flex-1">
    <MapLibre
      class="h-full w-full"
      style="https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json"
      zoom={6}
      center={{ lng: 133.5, lat: 33.5 }}
      onclick={handleMapClick}
    >
      <NavigationControl />
      <ScaleControl />
      <GlobeControl />

      <!-- マーカー -->
      {#if startPoint}
        <Marker lnglat={[startPoint.lng, startPoint.lat]} color="#10b981" />
      {/if}

      {#each waypoints as waypoint, index}
        <Marker 
          lnglat={[waypoint.lng, waypoint.lat]}
          offset={[0, -20]}
        >
          <div class="relative cursor-pointer">
            <!-- 黄色の円形背景 -->
            <div class="w-8 h-8 bg-yellow-500 rounded-full flex items-center justify-center shadow-lg border-2 border-white hover:bg-yellow-600 transition-colors">
              <span class="text-white font-bold text-sm">{index + 1}</span>
            </div>
            <!-- 下向きの三角形 -->
            <div class="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-0 h-0 
              border-l-[6px] border-l-transparent
              border-r-[6px] border-r-transparent
              border-t-[8px] border-t-yellow-500">
            </div>
          </div>
          <div slot="popup" class="text-sm">
            <p class="font-medium">経由地 {index + 1}</p>
            <p class="text-xs text-gray-600">
              {formatCoordinate(waypoint.lat, true)}<br>
              {formatCoordinate(waypoint.lng, false)}
            </p>
          </div>
        </Marker>
      {/each}

      {#if endPoint}
        <Marker lnglat={[endPoint.lng, endPoint.lat]} color="#ef4444" />
      {/if}

      <!-- 回避エリアの表示 -->
      {#each avoidAreas as area, index}
        <!-- 円形エリアをGeoJSONで表示 -->
        <GeoJSONSource
          data={{
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: [area.lon, area.lat]
            },
            properties: {
              radius: area.radius
            }
          }}
        >
          <LineLayer
            id={`avoid-area-circle-${index}`}
            type="circle"
            paint={{
              'circle-radius': {
                stops: [
                  [0, 0],
                  [20, area.radius / 4] // 地図のズームレベルに応じて調整
                ],
                base: 2
              },
              'circle-color': '#dc2626',
              'circle-opacity': 0.3,
              'circle-stroke-width': 2,
              'circle-stroke-color': '#dc2626',
              'circle-stroke-opacity': 0.8
            }}
          />
        </GeoJSONSource>
        
        <!-- 中心点マーカー -->
        <Marker 
          lnglat={[area.lon, area.lat]}
          offset={[0, 0]}
        >
          <div class="relative cursor-pointer">
            <div class="w-6 h-6 bg-red-600 rounded-full flex items-center justify-center shadow-lg border-2 border-white hover:bg-red-700 transition-colors">
              <span class="text-white font-bold text-xs">×</span>
            </div>
          </div>
          <div slot="popup" class="text-sm">
            <p class="font-medium">回避エリア {index + 1}</p>
            <p class="text-xs text-gray-600">
              半径: {area.radius}m<br>
              {formatCoordinate(area.lat, true)}<br>
              {formatCoordinate(area.lon, false)}
            </p>
          </div>
        </Marker>
      {/each}

      <!-- 全ルート表示（薄く） -->
      {#if allRoutesGeoJSON}
        <GeoJSONSource data={allRoutesGeoJSON}>
          <LineLayer
            id="all-routes"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{
              'line-color': [
                'case',
                ['==', ['get', 'routeType'], 'shortest'],
                '#22c55e', // 緑色（最短経路）
                '#3b82f6'  // 青色（最速経路）
              ],
              'line-width': [
                'case',
                ['get', 'selected'],
                5,
                3
              ],
              'line-opacity': [
                'case',
                ['get', 'selected'],
                0.8,
                0.3
              ]
            }}
          />
        </GeoJSONSource>
      {/if}
    </MapLibre>
  </div>
</div>