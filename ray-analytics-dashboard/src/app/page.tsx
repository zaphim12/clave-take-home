"use client";

import { useState } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

// ---------------- Types ----------------

type VisualizationType = "line" | "bar" | "pie" | "table" | "metric_card";

type QueryIntent = {
  metric: "revenue" | "orders" | "items_sold";
  dimensions: Array<"location" | "product" | "category" | "time">;
  filters: {
    date_range?: { start: string; end: string };
    locations?: string[];
    fulfillmentMethods?: ("delivery" | "pickup" | "dine_in")[];
    categories?: string[];
  };
  groupBy?: "location" | "product" | "date" | "hour" | "fulfillment_method" | "category";
  limit?: number;
  sortBy?: "value" | "count" | "name" | "date";
  sortOrder?: "asc" | "desc";
};

type LLMResponse = {
  visualization: VisualizationType;
  intent: QueryIntent;
  chartTitle: string;
  explanation?: string; // Human-readable summary of what's being shown
  data?: ChartDataPoint[]; // data returned from database
};

// ---------------- API Call ----------------

async function interpretPromptWithLLM(
  userPrompt: string
): Promise<LLMResponse> {
  const res = await fetch("/api/interpret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: userPrompt }),
  });

  if (!res.ok) {
    throw new Error("Failed to interpret prompt");
  }

  return res.json();
}

type ChartDataPoint = {
  name: string;
  value: number;
};

type MetricCardProps = {
  title: string;
  value: number;
  subtitle?: string;
  delta?: number; // percent change, optional
};

function MetricCard({ title, value, subtitle, delta }: MetricCardProps) {
  const isPositive = delta !== undefined && delta >= 0;

  return (
    <div className="h-full w-full rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="text-sm font-medium text-gray-500">{title}</div>

      <div className="mt-2 flex items-end gap-3">
        <div className="text-4xl font-semibold text-gray-900">
          {value.toLocaleString()}
        </div>

        {delta !== undefined && (
          <div
            className={`text-sm font-medium ${
              isPositive ? "text-green-600" : "text-red-600"
            }`}
          >
            {isPositive ? "▲" : "▼"} {Math.abs(delta)}%
          </div>
        )}
      </div>

      {subtitle && (
        <div className="mt-1 text-sm text-gray-400">{subtitle}</div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const [prompt, setPrompt] = useState<string>("");
  const [visualization, setVisualization] =
    useState<VisualizationType | null>(null);
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [chartTitle, setChartTitle] = useState<string>("Results");
  const [loading, setLoading] = useState<boolean>(false);

  const COLORS = ["#0c53c5ff", "#22c55e", "#f97316", "#ef4444", "#a855f7", "#bdeb18ff", "#06bfe4ff", "#efdb44ff", "#777777ff"];

  async function handleSubmit(
    e: React.FormEvent<HTMLFormElement>
  ): Promise<void> {
    e.preventDefault();
    setLoading(true);

    const llmResponse = await interpretPromptWithLLM(prompt);
    setVisualization(llmResponse.visualization);
    
    // Use real data from Supabase if available, otherwise fall back to mock data
    if (llmResponse.data && llmResponse.data.length > 0) {
      setChartData(llmResponse.data);
      setChartTitle(llmResponse.chartTitle);
    } else {
      setChartData([]);
    }

    setLoading(false);
  }

  return (
    <div style={{ padding: 32, maxWidth: 800, margin: "0 auto" }}>
      <h1>Natural Language Dashboard</h1>

      <form onSubmit={handleSubmit} style={{ marginBottom: 24 }}>
        <input
          type="text"
          placeholder="e.g. Compare sales between Downtown and Airport"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          style={{
            width: "100%",
            padding: 12,
            fontSize: 16,
            marginBottom: 12,
          }}
        />

        <button
          type="submit"
          disabled={loading}
          style={{ padding: "8px 16px", fontSize: 16 }}
        >
          {loading ? "Thinking..." : "Generate"}
        </button>
      </form>

      {(visualization === "bar" || visualization === "line" || visualization === "pie") && (
        <div
          style={{
            width: "100%",
            height: 300,
            backgroundColor: "#f5f5f5",
            padding: 16,
            borderRadius: 8,
            marginTop: 16,
          }}
        >
          <h3 style={{ color: "#000" }}>{chartTitle}</h3>

          <ResponsiveContainer>
            {visualization === "bar" && (
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ccc" />
                <XAxis dataKey="name" stroke="#333" />
                <YAxis stroke="#333" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#fff",
                    border: "1px solid #ccc",
                    color: "#000",
                  }}
                />
                <Bar dataKey="value" fill="#3b82f6" />
              </BarChart>
            )}

            {visualization === "line" && (
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ccc" />
                <XAxis dataKey="name" stroke="#333" />
                <YAxis stroke="#333" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#fff",
                    border: "1px solid #ccc",
                    color: "#000",
                  }}
                />
                <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={2} />
              </LineChart>
            )}

            {visualization === "pie" && (
              <PieChart>
                <Tooltip />
                <Pie
                  data={chartData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label
                >
                  {chartData.map((_, index) => (
                    <Cell key={index} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
              </PieChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    {visualization === "table" && (
      <div className="overflow-x-auto">
        <table className="min-w-full border border-gray-300 text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="border px-3 py-2 text-left">Name</th>
              <th className="border px-3 py-2 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {chartData.map((row, i) => (
              <tr key={i}>
                <td className="border px-3 py-2">{row.name}</td>
                <td className="border px-3 py-2 text-right">{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
    {visualization === "metric_card" && (
      <MetricCard
        title={chartTitle}
        // value={chartData.reduce((sum, d) => sum + d.value, 0)}
        value={chartData[0]?.value ?? 0}
        delta={chartData.length > 1 ? ((chartData[0].value - chartData[1].value) / chartData[1].value * 100) : undefined}
      />
    )}
    </div>
  );
}
