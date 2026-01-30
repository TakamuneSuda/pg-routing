import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { Pool } from 'pg';

// データベース接続プールの作成
const pool = new Pool({
	host: 'localhost',
	port: 5432,
	database: 'shikoku_routing',
	user: 'user',
	password: 'password'
});

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { 
			startLat, 
			startLon, 
			endLat, 
			endLon,
			waypoints = [],
			avoidMotorways = false,
			vehicleWidth = null,
			vehicleHeight = null,
			avoidAreas = []
		} = await request.json();

		// 入力値の検証
		if (!startLat || !startLon || !endLat || !endLon) {
			return json({ error: '開始地点と終了地点の座標が必要です' }, { status: 400 });
		}

		// 最寄りノード検索のクエリ
		const nearestNodeQuery = `
			SELECT id, ST_Distance(
				the_geom::geography,
				ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
			) as distance
			FROM ways_vertices_pgr
			ORDER BY the_geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
			LIMIT 1;
		`;

		// すべての地点（開始、経由地、終了）の最寄りノードを取得
		const allPoints = [
			{ lat: startLat, lon: startLon, type: 'start' },
			...waypoints.map((wp: any, idx: number) => ({ lat: wp.lat, lon: wp.lon, type: `waypoint-${idx}` })),
			{ lat: endLat, lon: endLon, type: 'end' }
		];

		const nodeResults = await Promise.all(
			allPoints.map(point => 
				pool.query(nearestNodeQuery, [point.lon, point.lat])
					.then(result => ({
						...point,
						nodeId: result.rows[0]?.id,
						found: result.rows.length > 0
					}))
			)
		);

		// ノードが見つからない地点をチェック
		const missingNodes = nodeResults.filter(n => !n.found);
		if (missingNodes.length > 0) {
			return json({ 
				error: '指定された座標の近くにノードが見つかりません',
				missingPoints: missingNodes.map(n => n.type)
			}, { status: 404 });
		}

		const nodeIds = nodeResults.map(n => n.nodeId);

		// 動的WHERE句の構築
		const buildWhereClause = (baseWhere: string = '') => {
			const conditions = [];
			
			if (baseWhere) {
				conditions.push(baseWhere);
			}

			// 高速道路を避ける
			if (avoidMotorways) {
				conditions.push(`
					NOT EXISTS (
						SELECT 1 FROM configuration c 
						WHERE c.tag_id = ways.tag_id 
						AND c.tag_value IN (''motorway'', ''motorway_link'')
					)
				`);
			}

			// 車両幅の制約（実際のwidthカラムがないため、tag_idベースで簡易的に実装）
			// 狭い道路を除外（residential, service roads）
			if (vehicleWidth && vehicleWidth > 2.5) {
				conditions.push(`
					NOT EXISTS (
						SELECT 1 FROM configuration c 
						WHERE c.tag_id = ways.tag_id 
						AND c.tag_value IN (''service'', ''residential'', ''living_street'', ''track'')
					)
				`);
			}

			// 車両高さの制約（maxheightカラムがないため、トンネルや橋を考慮）
			// 実装は簡易的
			if (vehicleHeight && vehicleHeight > 3.5) {
				// 高さ制限がある可能性のある道路タイプを除外
				conditions.push(`
					NOT EXISTS (
						SELECT 1 FROM configuration c 
						WHERE c.tag_id = ways.tag_id 
						AND c.tag_value IN (''tunnel'')
					)
				`);
			}

			// 回避エリアの制約
			if (avoidAreas && avoidAreas.length > 0) {
				const avoidConditions = avoidAreas.map((area: any, index: number) => {
					const radiusMeters = area.radius || 500; // デフォルト半径500m
					// PostGISのST_Bufferは度単位なので、メートルを概算で度に変換（緯度33度付近）
					const radiusDegrees = radiusMeters / 111000; // 1度≈111km
					
					return `
						NOT ST_Intersects(
							ways.the_geom,
							ST_Buffer(
								ST_SetSRID(ST_MakePoint(${area.lon}, ${area.lat}), 4326)::geography,
								${radiusMeters}
							)::geometry
						)
					`;
				}).join(' AND ');
				
				conditions.push(avoidConditions);
			}

			return conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
		};

		const whereClause = buildWhereClause();
		const whereClauseWithCostMinutes = buildWhereClause('cost_s IS NOT NULL');

		// 1. 最短経路検索（距離ベース）
		const shortestRouteQuery = `
			SELECT 
				r.seq,
				r.path_seq,
				r.node,
				r.edge,
				r.cost,
				r.agg_cost,
				ST_AsGeoJSON(w.the_geom) as geom,
				w.name,
				w.length_m,
				(w.cost_s / 60.0) as cost_minutes,
				c.tag_value as road_type
			FROM pgr_dijkstra(
				'SELECT gid as id, source, target, length_m as cost, length_m as reverse_cost FROM ways ${whereClause}',
				$1::integer,
				$2::integer,
				true
			) as r
			LEFT JOIN ways w ON r.edge = w.gid
			LEFT JOIN configuration c ON w.tag_id = c.tag_id
			WHERE r.edge IS NOT NULL;
		`;

		// 2. 最速経路検索（時間ベース）
		const fastestRouteQuery = `
			SELECT 
				r.seq,
				r.path_seq,
				r.node,
				r.edge,
				r.cost,
				r.agg_cost,
				ST_AsGeoJSON(w.the_geom) as geom,
				w.name,
				w.length_m,
				(w.cost_s / 60.0) as cost_minutes,
				c.tag_value as road_type
			FROM pgr_dijkstra(
				'SELECT gid as id, source, target, cost_s as cost, cost_s as reverse_cost FROM ways ${whereClauseWithCostMinutes}',
				$1::integer,
				$2::integer,
				true
			) as r
			LEFT JOIN ways w ON r.edge = w.gid
			LEFT JOIN configuration c ON w.tag_id = c.tag_id
			WHERE r.edge IS NOT NULL;
		`;

		// 各区間のルートを計算する関数
		const calculateLegRoute = async (fromNodeId: number, toNodeId: number, routeType: 'shortest' | 'fastest') => {
			const query = routeType === 'shortest' ? shortestRouteQuery : fastestRouteQuery;
			const result = await pool.query(query, [fromNodeId, toNodeId]);
			return result.rows;
		};

		// すべての区間のルートを計算
		const calculateMultiLegRoute = async (routeType: 'shortest' | 'fastest') => {
			const allLegs = [];
			
			// 各区間（開始→経由地1、経由地1→経由地2、...、最後の経由地→終了）を計算
			for (let i = 0; i < nodeIds.length - 1; i++) {
				const fromNode = nodeIds[i];
				const toNode = nodeIds[i + 1];
				const legRows = await calculateLegRoute(fromNode, toNode, routeType);
				
				if (legRows.length === 0) {
					// この区間でルートが見つからない場合
					return null;
				}
				
				allLegs.push({
					fromIndex: i,
					toIndex: i + 1,
					fromPoint: allPoints[i],
					toPoint: allPoints[i + 1],
					rows: legRows
				});
			}
			
			return allLegs;
		};

		// 最短経路と最速経路の両方を計算
		const [shortestLegs, fastestLegs] = await Promise.all([
			calculateMultiLegRoute('shortest'),
			calculateMultiLegRoute('fastest')
		]);

		if (!shortestLegs && !fastestLegs) {
			return json({ error: 'ルートが見つかりません' }, { status: 404 });
		}

		// 複数区間のルートを統合する関数
		const formatMultiLegRoute = (legs: any[] | null, routeType: 'shortest' | 'fastest') => {
			if (!legs || legs.length === 0) return null;

			// すべての区間のセグメントを結合
			const allSegments = [];
			let totalDistance = 0;
			let totalMinutes = 0;
			let totalCost = 0;
			let sequenceOffset = 0;

			for (const leg of legs) {
				const legDistance = leg.rows.reduce((sum: number, row: any) => sum + (row.length_m || 0), 0);
				const legMinutes = leg.rows.reduce((sum: number, row: any) => sum + (row.cost_minutes || 0), 0);
				const legCost = leg.rows[leg.rows.length - 1]?.agg_cost || 0;

				totalDistance += legDistance;
				totalMinutes += legMinutes;
				totalCost += legCost;

				// セグメントを追加（シーケンス番号を調整）
				leg.rows.forEach((row: any) => {
					allSegments.push({
						sequence: sequenceOffset + row.seq,
						node: row.node,
						edge: row.edge,
						cost: row.cost,
						costMinutes: row.cost_minutes,
						accumulatedCost: totalCost - legCost + row.agg_cost,
						geometry: row.geom ? JSON.parse(row.geom) : null,
						name: row.name,
						length: row.length_m,
						roadType: row.road_type,
						legIndex: leg.fromIndex
					});
				});

				sequenceOffset += leg.rows.length;
			}

			return {
				routeType,
				label: routeType === 'shortest' ? '最短経路' : '最速経路',
				startNode: nodeIds[0],
				endNode: nodeIds[nodeIds.length - 1],
				waypoints: waypoints.map((wp: any, idx: number) => ({
					...wp,
					nodeId: nodeIds[idx + 1]
				})),
				totalCost,
				totalDistance,
				totalMinutes,
				estimatedDuration: totalMinutes * 60,
				segments: allSegments,
				legs: legs.map(leg => ({
					from: leg.fromPoint,
					to: leg.toPoint,
					distance: leg.rows.reduce((sum: number, row: any) => sum + (row.length_m || 0), 0),
					minutes: leg.rows.reduce((sum: number, row: any) => sum + (row.cost_minutes || 0), 0)
				}))
			};
		};

		// 両方のルートを整形
		const routes = {
			shortest: formatMultiLegRoute(shortestLegs, 'shortest'),
			fastest: formatMultiLegRoute(fastestLegs, 'fastest'),
			routes: [
				formatMultiLegRoute(shortestLegs, 'shortest'),
				formatMultiLegRoute(fastestLegs, 'fastest')
			].filter(route => route !== null),
			waypoints,
			avoidAreas,
			constraints: {
				avoidMotorways,
				vehicleWidth,
				vehicleHeight,
				avoidAreas: avoidAreas.length
			}
		};

		return json(routes);
	} catch (error) {
		console.error('Routing error:', error);
		return json({ error: 'ルート検索中にエラーが発生しました' }, { status: 500 });
	}
};
